import type { TableColumn } from "../output/table.js";
import { isSystemRoleName, SYSTEM_ROLE_NAMES, systemRoleDescription } from "../role/systemRoles.js";
import type { TaskStore } from "../storage/taskStore.js";
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
  preferredRole?: string;
};

export function getSelectionCandidates(
  selector: ArgumentSelector,
  store: TaskStore,
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
          { header: "Command", minWidth: 7, maxWidth: 80 },
          { header: "Default", minWidth: 7, maxWidth: 7 }
        ],
        candidates: agents.map((agent) => ({
          value: agent.id,
          cells: [agent.id, [agent.command, ...agent.args].join(" "), agent.id === config.defaultAgent ? "yes" : ""]
        })),
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
              role?.agent ?? "?",
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
          cells: [role.name, role.agent, "custom"]
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
            role.agent,
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
          cells: [role.name, role.agent, role.status]
        })),
        defaultValue: context.preferredRole,
        emptyMessage: `Task ${taskId} has no roles. Run \`taskmux task roles ${taskId}\`.`,
        overflowHint: `Run \`taskmux task roles ${taskId}\` and pass the selected role explicitly.`
      };
    }
  }
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
