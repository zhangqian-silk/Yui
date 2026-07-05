import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createTaskComment } from "../comment/comment.js";
import { roleNotFound, runtimeError, taskNotFound, usageError } from "../errors/cliError.js";
import { createTaskEvent } from "../event/taskEvent.js";
import { copyGlobalRoleToTaskRole, createRole, updateRole, updateRoleStatus } from "../role/role.js";
import { SYSTEM_OWNER_ROLE } from "../role/systemRoles.js";
import { resolveRunner, supportedRunnerIds } from "../runner/runnerRegistry.js";
import { createTask, updateTaskMetadata, updateTaskStatus } from "../task/task.js";
import type { TaskComment } from "../comment/comment.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { Role } from "../role/role.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { Task, TaskMetadata, TaskPriority, TaskStatus } from "../task/task.js";
import type { TmuxManager } from "../tmux/tmuxManager.js";

const BUILTIN_OWNER_ROLE = SYSTEM_OWNER_ROLE;

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
    case "start":
      return updateTaskStatusCommand(rest, store, "active", "Started");
    case "done":
      return updateTaskStatusCommand(rest, store, "done", "Completed");
    case "archive":
      return updateTaskStatusCommand(rest, store, "archived", "Archived");
    case "reopen":
      return updateTaskStatusCommand(rest, store, "open", "Reopened");
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
    default:
      return taskUsage();
  }
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
  const assignedRoles = uniqueStrings([BUILTIN_OWNER_ROLE, ...(template?.roles ?? [])])
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

  return `${tasks.map(renderTaskListRow).join("\n")}\n`;
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
    `Status: ${task.status}`,
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

  return `Current task: ${task.id}\t${task.title}\n`;
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
    owner: sourceTask.owner,
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
      new Date()
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

function updateTaskStatusCommand(
  args: string[],
  store: TaskStore,
  status: TaskStatus,
  action: string
): string {
  const [id] = args;

  if (id === undefined || id.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  const task = store.getTask(id);

  if (task === null) {
    throw taskNotFound(id);
  }

  const updatedTask = updateTaskStatus(task, status, new Date());
  store.saveTask(updatedTask);
  recordTaskEvent(store, updatedTask.id, "task.status_changed", {
    from: task.status,
    to: updatedTask.status
  });

  return `${action} task ${updatedTask.id}\n`;
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
    `Status: ${task.status}`,
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
    case "update":
      return updateTaskRoleCommand(rest, store);
    case "rename":
      return renameTaskRoleCommand(rest, store, tmux);
    default:
      return taskUsage();
  }
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

  if (oldName === BUILTIN_OWNER_ROLE || newName.trim() === BUILTIN_OWNER_ROLE) {
    throw usageError("Built-in owner role cannot be renamed.");
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

  return `${roles.map((role) => `${role.name}\t${role.agent}\t${role.status}\t${role.workspace}`).join("\n")}\n`;
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

  return [
    `${action} task ${taskId} roles`,
    ...currentRoles.map((role) => `${role.name}\t${role.status}`)
  ].join("\n").concat("\n");
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

  const comment = createTaskComment(store.nextCommentId(taskId), body, new Date());
  store.saveComment(taskId, comment);
  recordTaskEvent(store, taskId, "comment.added", { comment: comment.id });

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

  return `${comments.map((comment) => `${comment.id}\t${comment.createdAt}\t${comment.body}`).join("\n")}\n`;
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

  return `${events
    .map((event) => `${event.id}\t${event.createdAt}\t${event.type}\t${renderEventPayload(event.payload)}`)
    .join("\n")}\n`;
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

  return [
    `Task activity: ${taskId}`,
    ...roles.map((role) => {
      const transcript = store.readTranscript(taskId, role.name);
      return [
        role.name,
        role.agent,
        role.status,
        `transcriptLines=${countTranscriptLines(transcript)}`,
        `updated=${role.updatedAt}`
      ].join("\t");
    })
  ].join("\n").concat("\n");
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
      line: `${event.createdAt}\tevent\t${event.type}\t${renderEventPayload(event.payload)}`
    })),
    ...store.listComments(taskId).map((comment) => ({
      createdAt: comment.createdAt,
      line: `${comment.createdAt}\tcomment\t${comment.id}\t${comment.body}`
    }))
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  if (lines.length === 0) {
    return `Task timeline: ${taskId}\nNo timeline entries.\n`;
  }

  return [`Task timeline: ${taskId}`, ...lines.map((entry) => entry.line)].join("\n").concat("\n");
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
  roles: TaskContextRole[];
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
    roles: store.listRoles(task.id).map((role) => includeTranscripts
      ? { ...role, transcript: store.readTranscript(task.id, role.name) }
      : role),
    comments: store.listComments(task.id),
    events: store.listEvents(task.id)
  };
}

function renderTaskContextText(context: TaskContext, includeTranscripts: boolean): string {
  return [
    "Task Context",
    ...renderTaskContextTaskLines(context.task),
    "",
    "Roles",
    ...renderTaskContextRoles(context.roles, includeTranscripts),
    "",
    "Comments",
    ...renderTaskContextComments(context.comments),
    "",
    "Events",
    ...renderTaskContextEvents(context.events)
  ].join("\n").concat("\n");
}

function renderTaskContextTaskLines(task: Task): string[] {
  return [
    `Task: ${task.id}`,
    `Title: ${task.title}`,
    `Status: ${task.status}`,
    ...renderTaskMetadataLines(task),
    `Created: ${task.createdAt}`,
    `Updated: ${task.updatedAt}`
  ];
}

function renderTaskContextRoles(roles: TaskContextRole[], includeTranscripts: boolean): string[] {
  if (roles.length === 0) {
    return ["  No roles."];
  }

  return roles.flatMap((role) => {
    const lines = [`  ${role.name}\t${role.agent}\t${role.status}\t${role.workspace}`];

    if (includeTranscripts && role.transcript !== undefined) {
      const transcript = role.transcript;
      lines.push(`    Transcript: ${transcript === null ? "not captured" : transcript.trimEnd()}`);
    }

    return lines;
  });
}

function renderTaskContextComments(comments: TaskComment[]): string[] {
  if (comments.length === 0) {
    return ["  No comments."];
  }

  return comments.map((comment) => `  ${comment.id}\t${comment.body}`);
}

function renderTaskContextEvents(events: TaskEvent[]): string[] {
  if (events.length === 0) {
    return ["  No events."];
  }

  return events.map((event) => `  ${event.id}\t${event.type}\t${renderEventPayload(event.payload)}`);
}

function recordTaskEvent(
  store: TaskStore,
  taskId: string,
  type: string,
  payload: Record<string, string>
): void {
  store.saveEvent(taskId, createTaskEvent(store.nextEventId(taskId), type, payload, new Date()));
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
    return `${label}: ${taskId}\tmissing\n`;
  }

  return `${label}: ${task.id}\t${task.title}\n`;
}

function renderEventPayload(payload: Record<string, string>): string {
  return Object.entries(payload)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
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
  status?: TaskStatus;
  owner?: string;
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
  const owner = readOptionalOption(optionArgs, "--owner")?.trim();
  const dueAt = readOptionalOption(optionArgs, "--due")?.trim();

  const knownOptions = new Set(["--title", "--description", "--priority", "--tag", "--owner", "--due"]);

  for (const option of options.extraKnownOptions ?? []) {
    knownOptions.add(option);
  }

  if (options.allowClear === true) {
    knownOptions.add("--clear-description");
    knownOptions.add("--clear-priority");
    knownOptions.add("--clear-tags");
    knownOptions.add("--clear-owner");
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

  if (owner !== undefined && owner.length > 0) {
    metadata.owner = owner;
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

    if (hasFlag(optionArgs, "--clear-owner")) {
      metadata.owner = undefined;
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
  assertKnownOptions(args, new Set(["--status", "--owner", "--tag", "--priority", "--search"]));

  const status = parseTaskStatus(readOptionalOption(args, "--status"));

  return {
    status,
    owner: readOptionalOption(args, "--owner")?.trim(),
    tag: readOptionalOption(args, "--tag")?.trim(),
    priority: parseTaskPriority(readOptionalOption(args, "--priority")),
    search: readOptionalOption(args, "--search")?.trim().toLowerCase()
  };
}

function parseTaskBoardViewOptions(args: string[]): TaskBoardViewOptions {
  assertKnownOptions(args, new Set(["--status", "--owner", "--tag", "--priority", "--search", "--with-roles"]));

  return {
    filters: {
      status: parseTaskStatus(readOptionalOption(args, "--status")),
      owner: readOptionalOption(args, "--owner")?.trim(),
      tag: readOptionalOption(args, "--tag")?.trim(),
      priority: parseTaskPriority(readOptionalOption(args, "--priority")),
      search: readOptionalOption(args, "--search")?.trim().toLowerCase()
    },
    withRoles: hasFlag(args, "--with-roles")
  };
}

function taskMatchesFilters(task: Task, filters: TaskListFilters): boolean {
  if (filters.status !== undefined && task.status !== filters.status) {
    return false;
  }

  if (filters.owner !== undefined && task.owner !== filters.owner) {
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

function renderTaskListRow(task: Task): string {
  const metadata = renderTaskMetadataSummary(task);

  return `${task.id}\t${task.status}\t${task.title}${metadata.length === 0 ? "" : `\t${metadata}`}`;
}

function renderTaskBoard(tasks: Task[], store: TaskStore, withRoles: boolean): string {
  const groups: Array<{ status: TaskStatus; title: string }> = [
    { status: "open", title: "Open" },
    { status: "active", title: "Active" },
    { status: "done", title: "Done" },
    { status: "archived", title: "Archived" }
  ];
  const lines = groups.flatMap((group) => {
    const groupedTasks = tasks.filter((task) => task.status === group.status);

    if (groupedTasks.length === 0) {
      return [group.title, "  No tasks."];
    }

    return [group.title, ...groupedTasks.map((task) => renderTaskBoardRow(task, store, withRoles))];
  });

  return `${lines.join("\n")}\n`;
}

function renderTaskBoardRow(task: Task, store: TaskStore, withRoles: boolean): string {
  const summaries = [
    renderTaskMetadataSummary(task),
    withRoles ? renderTaskRoleSummary(store.listRoles(task.id)) : ""
  ].filter((summary) => summary.length > 0);

  return `  ${task.id}\t${task.title}${summaries.length === 0 ? "" : `\t${summaries.join(" ")}`}`;
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

  if (task.owner !== undefined) {
    lines.push(`Owner: ${task.owner}`);
  }

  if (task.dueAt !== undefined) {
    lines.push(`Due: ${task.dueAt}`);
  }

  return lines;
}

function renderTaskMetadataSummary(task: Task): string {
  return [
    task.priority === undefined ? null : `priority=${task.priority}`,
    task.owner === undefined ? null : `owner=${task.owner}`,
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
    task.owner,
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

function parseTaskStatus(value: string | undefined): TaskStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!["open", "active", "done", "archived"].includes(value)) {
    throw usageError("--status must be one of open, active, done, archived.");
  }

  return value as TaskStatus;
}

function assertDueAt(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw usageError("--due must use YYYY-MM-DD.");
  }
}

export function taskUsage(): string {
  return `Task commands:
  taskmux task create <title> [--template feature|bug|review] [--agent <agent>] [--workspace <path>] [--description <body>] [--priority low|medium|high|urgent] [--tag <tag> ...] [--owner <owner>] [--due YYYY-MM-DD]
  taskmux task update <task-id> [--title <title>] [--description <body>] [--priority low|medium|high|urgent] [--tag <tag> ...] [--owner <owner>] [--due YYYY-MM-DD] [--clear-description] [--clear-priority] [--clear-tags] [--clear-owner] [--clear-due]
  taskmux task list [--status <status>] [--owner <owner>] [--tag <tag>] [--priority <priority>] [--search <text>]
  taskmux task board [--status <status>] [--owner <owner>] [--tag <tag>] [--priority <priority>] [--search <text>] [--with-roles]
  taskmux task show <task-id>
  taskmux task current [<task-id>]
  taskmux task last
  taskmux task clone <task-id> [--title <title>]
  taskmux task start <task-id>
  taskmux task done <task-id>
  taskmux task archive <task-id>
  taskmux task reopen <task-id>
  taskmux task delete <task-id>
  taskmux task restore <task-id>
  taskmux task open <task-id>
  taskmux task context <task-id> [--format text|json] [--include-transcripts]
  taskmux task bind <task-id> <role> [--as <task-role>] [--workspace <path>]
  taskmux task assign <task-id> <role> [--agent <agent>] [--workspace <path>] [--as <task-role>]
  taskmux task assign-many <task-id> --role <role> ... [--agent <agent>] [--workspace <path>]
  taskmux task role update <task-id> <role> [--agent <agent>] [--workspace <path>]
  taskmux task role rename <task-id> <role> <new-role>
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
`;
}
