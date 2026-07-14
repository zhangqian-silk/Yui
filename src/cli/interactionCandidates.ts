import type { TableColumn } from "../output/table.js";
import { presentAgentDefinition } from "../output/roleAgentPresentation.js";
import { configuredAgentToDefinition } from "../agent/agent.js";
import { listGlobalInputRequests, resolveGlobalInputRequest } from "../input/globalInputQuery.js";
import { isSystemRoleName, SYSTEM_ROLE_NAMES, systemRoleDescription } from "../role/systemRoles.js";
import type { TaskReader, TaskStore } from "../storage/taskStore.js";
import { BUILTIN_TOPICS } from "../topic/topic.js";
import type { ArgumentSelector } from "./interactionPolicy.js";

export type SelectionCandidate = {
  value: string;
  cells: string[];
};

export type CandidateSet = {
  entityLabel: string;
  title: string;
  columns: TableColumn[];
  candidates: SelectionCandidate[];
  defaultValue?: string;
  emptyMessage: string;
  overflowHint: string;
};

export type CandidateContext = {
  preferredTask?: string;
  preferredRole?: string;
};

export function getSelectionCandidates(
  selector: ArgumentSelector,
  store: TaskStore,
  args: readonly string[],
  context: CandidateContext = {}
): CandidateSet | null {
  return store.runReadSnapshot((snapshot) =>
    getSelectionCandidatesSnapshot(selector, snapshot, args, context));
}

function getSelectionCandidatesSnapshot(
  selector: ArgumentSelector,
  store: TaskReader,
  args: readonly string[],
  context: CandidateContext = {}
): CandidateSet | null {
  switch (selector.provider) {
    case "configured-agents": {
      const config = store.getConfig();
      const agents = store.listConfiguredAgents().sort((left, right) => left.id.localeCompare(right.id));
      return {
        entityLabel: "agent",
        title: "Select agent",
        columns: [
          { header: "Agent", minWidth: 5, maxWidth: 24 },
          { header: "Command", minWidth: 7, maxWidth: 16 },
          { header: "Default", minWidth: 7, maxWidth: 7 }
        ],
        candidates: agents.map((agent) => {
          const definition = presentAgentDefinition(configuredAgentToDefinition(agent));
          return {
            value: definition.id,
            cells: [
              definition.id,
              definition.executable,
              definition.id === config.defaultAgent ? "yes" : ""
            ]
          };
        }),
        defaultValue: config.defaultAgent,
        emptyMessage: "No agents are configured. Run `taskmux agent add <agent-id> --command <command>`.",
        overflowHint: "Run `taskmux agent list` and pass the selected agent explicitly."
      };
    }
    case "global-roles-for-show": {
      const configured = new Map(store.listGlobalRoles().map((role) => [role.name, role]));
      const names = new Set([...SYSTEM_ROLE_NAMES, ...configured.keys()]);
      return globalRoleCandidateSet(
        [...names].sort((left, right) => left.localeCompare(right)).map((name) => {
          const role = configured.get(name);
          return {
            value: name,
            cells: [
              name,
              role?.activeAgentId ?? "?",
              isSystemRoleName(name)
                ? `system:${systemRoleDescription(name)}${role === undefined ? " (not configured)" : ""}`
                : "custom"
            ]
          };
        }),
        context.preferredRole,
        "No global roles are available."
      );
    }
    case "removable-global-roles": {
      const roles = store.listGlobalRoles()
        .filter((role) => !isSystemRoleName(role.name))
        .sort((left, right) => left.name.localeCompare(right.name));
      return globalRoleCandidateSet(
        roles.map((role) => ({
          value: role.name,
          cells: [role.name, role.activeAgentId, "custom"]
        })),
        context.preferredRole,
        "No removable global roles are configured. Run `taskmux role add <role> --agent <agent-id>`."
      );
    }
    case "configured-global-roles": {
      const roles = store.listGlobalRoles().sort((left, right) => left.name.localeCompare(right.name));
      return globalRoleCandidateSet(
        roles.map((role) => ({
          value: role.name,
          cells: [
            role.name,
            role.activeAgentId,
            isSystemRoleName(role.name) ? `system:${systemRoleDescription(role.name)}` : "custom"
          ]
        })),
        context.preferredRole,
        "No configured global roles are available. Run `taskmux role add <role> --agent <agent-id>`."
      );
    }
    case "tasks": {
      const config = store.getConfig();
      const tasks = store.listTasks();
      return {
        entityLabel: "task",
        title: "Select task",
        columns: [
          { header: "Task", minWidth: 6, maxWidth: 16 },
          { header: "Title", minWidth: 8, maxWidth: 48 },
          { header: "State", minWidth: 6, maxWidth: 8 },
          { header: "Current", minWidth: 7, maxWidth: 7 },
          { header: "Last", minWidth: 4, maxWidth: 4 }
        ],
        candidates: tasks.map((task) => ({
          value: task.id,
          cells: [
            task.id,
            task.title,
            task.archived ? "archived" : "active",
            task.id === config.currentTaskId ? "yes" : "",
            task.id === config.lastTaskId ? "yes" : ""
          ]
        })),
        defaultValue: config.currentTaskId,
        emptyMessage: "No tasks are available. Run `taskmux task create <title>`.",
        overflowHint: "Run `taskmux task list --search <text>` and pass the selected task explicitly."
      };
    }
    case "unarchived-tasks":
      return taskCandidateSet(store, store.listTasks().filter((task) => !task.archived), context, "No active tasks are available.");
    case "archived-tasks":
      return taskCandidateSet(store, store.listTasks().filter((task) => task.archived), context, "No archived tasks are available.");
    case "tasks-with-input-drafts":
      return taskCandidateSet(
        store,
        store.listTasks().filter((task) => store.getTaskInputDraft(task.id) !== null),
        context,
        "No tasks have drafted input."
      );
    case "input-requests":
      return inputRequestCandidateSet(
        listGlobalInputRequests(store, { includeTerminal: true }),
        "Select input request",
        "No input requests are available."
      );
    case "open-input-requests":
      return inputRequestCandidateSet(
        listGlobalInputRequests(store),
        "Select open input request",
        "No open input requests are available."
      );
    case "task-open-input-requests": {
      const taskId = dependentTaskId(selector, args, store);
      if (taskId === null) {
        return null;
      }
      return inputRequestCandidateSet(
        listGlobalInputRequests(store).filter((request) => request.taskId === taskId),
        `Select open input request: ${taskId}`,
        `Task ${taskId} has no open input requests.`
      );
    }
    case "input-answer-choices": {
      const requestId = args[3];
      if (requestId === undefined || requestId.startsWith("--")) {
        return null;
      }
      const taskId = readOptionValue(args, "--task");
      let request: ReturnType<typeof resolveGlobalInputRequest>;
      try {
        request = resolveGlobalInputRequest(store, requestId, taskId);
      } catch {
        return null;
      }
      if (request.status !== "open" || request.choices.length === 0) {
        return null;
      }
      return {
        entityLabel: "input answer",
        title: `Select answer: ${request.taskId}/${request.id}`,
        columns: [
          { header: "Choice", minWidth: 6, maxWidth: 24 },
          { header: "Label", minWidth: 8, maxWidth: 48 },
          { header: "Description", minWidth: 8, maxWidth: 64 }
        ],
        candidates: request.choices.map((choice) => ({
          value: choice.key,
          cells: [choice.key, choice.label, choice.description ?? ""]
        })),
        emptyMessage: `Input request ${request.id} has no selectable choices.`,
        overflowHint: `Pass --text for free-text input requests.`
      };
    }
    case "trashed-tasks": {
      const ids = store.listTrashedTaskIds();
      return {
        entityLabel: "trashed task",
        title: "Select trashed task",
        columns: [{ header: "Task", minWidth: 6, maxWidth: 24 }],
        candidates: ids.map((id) => ({ value: id, cells: [id] })),
        emptyMessage: "No restorable tasks are in trash.",
        overflowHint: "Run `taskmux prune --trash` only if the trash is no longer needed."
      };
    }
    case "task-roles": {
      const taskId = selector.dependsOn === undefined ? undefined : args[selector.dependsOn];
      if (taskId === undefined) {
        return null;
      }
      if (store.getTask(taskId) === null) {
        return null;
      }
      const roles = store.listRoles(taskId);
      return {
        entityLabel: "task role",
        title: `Select task role: ${taskId}`,
        columns: [
          { header: "Role", minWidth: 4, maxWidth: 24 },
          { header: "Agent", minWidth: 5, maxWidth: 20 },
          { header: "Status", minWidth: 6, maxWidth: 12 }
        ],
        candidates: roles.map((role) => ({
          value: role.name,
          cells: [role.name, role.activeAgentId, role.status]
        })),
        defaultValue: context.preferredRole,
        emptyMessage: `Task ${taskId} has no roles. Run \`taskmux task roles ${taskId}\`.`,
        overflowHint: `Run \`taskmux task roles ${taskId}\` and pass the selected role explicitly.`
      };
    }
    case "task-roles-with-transcripts":
      return taskRoleCandidateSet(selector, store, args, context, (taskId, roleName) =>
        store.readTranscript(taskId, roleName) !== null, "No task roles have a stored transcript.");
    case "task-roles-with-active-runs":
      return taskRoleCandidateSet(selector, store, args, context, (taskId, roleName) =>
        store.getActiveAgentRun(taskId, roleName) !== null, "No task roles have an active AgentRun.");
    case "task-roles-without-active-runs":
      return taskRoleCandidateSet(selector, store, args, context, (taskId, roleName) =>
        store.getActiveAgentRun(taskId, roleName) === null, "Every task role already has an active AgentRun.");
    case "removable-task-roles":
      return taskRoleCandidateSet(selector, store, args, context, (_taskId, roleName) =>
        roleName !== "leader", "No removable task roles are available.");
    case "worktree-task-roles":
      return taskRoleCandidateSet(selector, store, args, context, (taskId, roleName) =>
        roleName !== "leader" && store.getRoleWorktree(taskId, roleName) === null,
      "No task roles are eligible for a new worktree.");
    case "managed-worktree-task-roles":
      return taskRoleCandidateSet(selector, store, args, context, (taskId, roleName) =>
        roleName !== "leader" && store.getRoleWorktree(taskId, roleName) !== null,
      "No managed task role worktrees are available.");
    case "task-topics": {
      const taskId = dependentTaskId(selector, args, store);
      if (taskId === null) {
        return null;
      }
      const topics = [...BUILTIN_TOPICS, ...store.getTaskTopics(taskId).customTopics];
      return {
        entityLabel: "topic",
        title: `Select topic: ${taskId}`,
        columns: [
          { header: "Topic", minWidth: 5, maxWidth: 24 },
          { header: "Name", minWidth: 4, maxWidth: 28 },
          { header: "Description", minWidth: 11, maxWidth: 48 }
        ],
        candidates: topics.map((topic) => ({ value: topic.id, cells: [topic.id, topic.name, topic.description] })),
        emptyMessage: `Task ${taskId} has no topics.`,
        overflowHint: `Run \`taskmux task topic list ${taskId}\`.`
      };
    }
    case "active-cycles": {
      const taskId = dependentTaskId(selector, args, store);
      if (taskId === null) {
        return null;
      }
      const cycles = store.listCycles(taskId).filter((cycle) => cycle.status === "active");
      return {
        entityLabel: "cycle",
        title: `Select active cycle: ${taskId}`,
        columns: [
          { header: "Cycle", minWidth: 5, maxWidth: 20 },
          { header: "Cause", minWidth: 5, maxWidth: 20 },
          { header: "Summary", minWidth: 7, maxWidth: 56 }
        ],
        candidates: cycles.map((cycle) => ({ value: cycle.id, cells: [cycle.id, cycle.cause, cycle.summary] })),
        emptyMessage: `Task ${taskId} has no active cycles.`,
        overflowHint: `Create one with \`taskmux task cycle create ${taskId} ...\`.`
      };
    }
    case "open-work-items":
    case "work-items":
    case "dispatch-work-items": {
      const taskId = dependentTaskId(selector, args, store);
      if (taskId === null) {
        return null;
      }
      const roleName = selector.provider === "dispatch-work-items" ? args[3] : undefined;
      if (selector.provider === "dispatch-work-items" && (roleName === undefined || store.getRole(taskId, roleName) === null)) {
        return null;
      }
      const items = store.listWorkItems(taskId).filter((item) =>
        (selector.provider === "work-items" || ["pending", "running"].includes(item.status))
        && (roleName === undefined || item.assignee === roleName)
      );
      return {
        entityLabel: "work item",
        title: `Select work item: ${taskId}`,
        columns: [
          { header: "Work item", minWidth: 9, maxWidth: 20 },
          { header: "Title", minWidth: 5, maxWidth: 48 },
          { header: "Assignee", minWidth: 8, maxWidth: 24 },
          { header: "Status", minWidth: 6, maxWidth: 10 }
        ],
        candidates: items.map((item) => ({ value: item.id, cells: [item.id, item.title, item.assignee, item.status] })),
        emptyMessage: `Task ${taskId} has no open work items.`,
        overflowHint: `Create one with \`taskmux task work-item create ${taskId} ...\`.`
      };
    }
    case "active-decisions": {
      const taskId = dependentTaskId(selector, args, store);
      if (taskId === null) {
        return null;
      }
      const decisions = store.listDecisions(taskId).filter((decision) => decision.status === "active");
      return {
        entityLabel: "decision",
        title: `Select active decision: ${taskId}`,
        columns: [
          { header: "Decision", minWidth: 8, maxWidth: 20 },
          { header: "Title", minWidth: 5, maxWidth: 48 }
        ],
        candidates: decisions.map((decision) => ({ value: decision.id, cells: [decision.id, decision.title] })),
        emptyMessage: `Task ${taskId} has no active decisions.`,
        overflowHint: `Record one with \`taskmux task decision record ${taskId} ...\`.`
      };
    }
  }
}

function taskCandidateSet(
  store: TaskReader,
  tasks: ReturnType<TaskStore["listTasks"]>,
  context: CandidateContext,
  emptyMessage: string
): CandidateSet {
  const config = store.getConfig();
  return {
    entityLabel: "task",
    title: "Select task",
    columns: [
      { header: "Task", minWidth: 6, maxWidth: 16 },
      { header: "Title", minWidth: 8, maxWidth: 48 },
      { header: "State", minWidth: 6, maxWidth: 8 },
      { header: "Current", minWidth: 7, maxWidth: 7 },
      { header: "Last", minWidth: 4, maxWidth: 4 }
    ],
    candidates: tasks.map((task) => ({
      value: task.id,
      cells: [
        task.id,
        task.title,
        task.archived ? "archived" : "active",
        task.id === config.currentTaskId ? "yes" : "",
        task.id === config.lastTaskId ? "yes" : ""
      ]
    })),
    defaultValue: context.preferredTask ?? config.currentTaskId,
    emptyMessage,
    overflowHint: "Run `taskmux task list` and pass the selected task explicitly."
  };
}

function inputRequestCandidateSet(
  requests: ReturnType<typeof listGlobalInputRequests>,
  title: string,
  emptyMessage: string
): CandidateSet {
  return {
    entityLabel: "input request",
    title,
    columns: [
      { header: "Task", minWidth: 6, maxWidth: 16 },
      { header: "Request", minWidth: 8, maxWidth: 42 },
      { header: "Status", minWidth: 7, maxWidth: 16 },
      { header: "Question", minWidth: 12, maxWidth: 64 }
    ],
    candidates: requests.map((request) => ({
      value: request.id,
      cells: [request.taskId, request.id, request.status, request.question]
    })),
    emptyMessage,
    overflowHint: "Run `taskmux task input list --all` and pass the request id explicitly."
  };
}

function readOptionValue(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option);
  const value = index === -1 ? undefined : args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function dependentTaskId(selector: ArgumentSelector, args: readonly string[], store: TaskReader): string | null {
  const taskId = selector.dependsOn === undefined ? undefined : args[selector.dependsOn];
  return taskId !== undefined && store.getTask(taskId) !== null ? taskId : null;
}

function taskRoleCandidateSet(
  selector: ArgumentSelector,
  store: TaskReader,
  args: readonly string[],
  context: CandidateContext,
  include: (taskId: string, roleName: string) => boolean,
  emptyMessage: string
): CandidateSet | null {
  const taskId = dependentTaskId(selector, args, store);
  if (taskId === null) {
    return null;
  }
  const roles = store.listRoles(taskId).filter((role) => include(taskId, role.name));
  return {
    entityLabel: "task role",
    title: `Select task role: ${taskId}`,
    columns: [
      { header: "Role", minWidth: 4, maxWidth: 24 },
      { header: "Agent", minWidth: 5, maxWidth: 20 },
      { header: "Status", minWidth: 6, maxWidth: 12 }
    ],
    candidates: roles.map((role) => ({ value: role.name, cells: [role.name, role.activeAgentId, role.status] })),
    defaultValue: context.preferredRole,
    emptyMessage,
    overflowHint: `Run \`taskmux task roles ${taskId}\`.`
  };
}

function globalRoleCandidateSet(
  candidates: SelectionCandidate[],
  defaultValue: string | undefined,
  emptyMessage: string
): CandidateSet {
  return {
    entityLabel: "global role",
    title: "Select global role",
    columns: [
      { header: "Role", minWidth: 4, maxWidth: 24 },
      { header: "Agent", minWidth: 5, maxWidth: 20 },
      { header: "Kind", minWidth: 6, maxWidth: 46 }
    ],
    candidates,
    defaultValue,
    emptyMessage,
    overflowHint: "Run `taskmux role list` and pass the selected role explicitly."
  };
}
