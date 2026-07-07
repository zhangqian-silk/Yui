import { SYSTEM_ROLE_NAMES, systemRoleDescription } from "../role/systemRoles.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import type { TaskStore } from "../storage/taskStore.js";

export function runBoardCommand(store: TaskStore): string {
  return [
    "TaskMux board",
    "",
    renderAgents(store),
    "",
    renderGlobalRoles(store)
  ].join("\n").concat("\n");
}

function renderAgents(store: TaskStore): string {
  const agents = store.listCustomRunners();

  return renderTable(
    "Agents",
    [
      { header: "Agent", minWidth: 5, maxWidth: 24 },
      { header: "Command", minWidth: 7, maxWidth: 80 }
    ],
    agents.map((agent) => [agent.id, [agent.command, ...agent.args].join(" ")]),
    defaultTableWidth()
  );
}

function renderGlobalRoles(store: TaskStore): string {
  const roles = store.listGlobalRoles();
  const rows = new Map<string, string[]>();

  for (const name of SYSTEM_ROLE_NAMES) {
    const role = store.getGlobalRole(name);

    rows.set(name, role === null
      ? [name, "?", "?", `system:${systemRoleDescription(name)}`]
      : [role.name, role.agent, role.workspace, `system:${systemRoleDescription(name)}`]);
  }

  for (const role of roles) {
    if (!rows.has(role.name)) {
      rows.set(role.name, [role.name, role.agent, role.workspace, "custom"]);
    }
  }

  return renderTable(
    "Roles",
    [
      { header: "Role", minWidth: 4, maxWidth: 24 },
      { header: "Agent", minWidth: 5, maxWidth: 20 },
      { header: "Workspace", minWidth: 9, maxWidth: 54 },
      { header: "Kind", minWidth: 6, maxWidth: 34 }
    ],
    [...rows.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, row]) => row),
    defaultTableWidth()
  );
}
