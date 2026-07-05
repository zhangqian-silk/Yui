import { SYSTEM_ROLE_NAMES, systemRoleDescription } from "../role/systemRoles.js";
import type { TaskStore } from "../storage/taskStore.js";

export function runBoardCommand(store: TaskStore): string {
  return [
    "TaskMux board",
    "",
    "Agents",
    ...renderAgents(store),
    "",
    "Roles",
    ...renderGlobalRoles(store)
  ].join("\n").concat("\n");
}

function renderAgents(store: TaskStore): string[] {
  const agents = store.listCustomRunners();

  if (agents.length === 0) {
    return ["  No agents configured."];
  }

  return agents.map((agent) => `  ${agent.id}\t${[agent.command, ...agent.args].join(" ")}`);
}

function renderGlobalRoles(store: TaskStore): string[] {
  const roles = store.listGlobalRoles();
  const rows = new Map<string, string>();

  for (const name of SYSTEM_ROLE_NAMES) {
    const role = store.getGlobalRole(name);

    rows.set(name, role === null
      ? `  ${name}\t?\t?\tsystem:${systemRoleDescription(name)}`
      : `  ${role.name}\t${role.agent}\t${role.workspace}\tsystem:${systemRoleDescription(name)}`);
  }

  for (const role of roles) {
    if (!rows.has(role.name)) {
      rows.set(role.name, `  ${role.name}\t${role.agent}\t${role.workspace}\tcustom`);
    }
  }

  if (rows.size === 0) {
    return ["  No roles configured."];
  }

  return [...rows.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, row]) => row);
}
