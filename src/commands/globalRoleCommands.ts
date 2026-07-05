import { spawnSync } from "node:child_process";
import { roleNotFound, usageError } from "../errors/cliError.js";
import { createGlobalRole, updateGlobalRole } from "../role/role.js";
import type { GlobalRole } from "../role/role.js";
import { isSystemRoleName, SYSTEM_ROLE_NAMES, systemRoleDescription } from "../role/systemRoles.js";
import { resolveRunner, supportedRunnerIds } from "../runner/runnerRegistry.js";
import type { TaskStore } from "../storage/taskStore.js";

export function runGlobalRoleCommand(args: string[], store: TaskStore): string {
  const [command, ...rest] = args;

  switch (command) {
    case "add":
      return addGlobalRoleCommand(rest, store);
    case "list":
      return listGlobalRoleCommand(store);
    case "show":
      return showGlobalRoleCommand(rest, store);
    case "update":
      return updateGlobalRoleCommand(rest, store);
    case "remove":
      return removeGlobalRoleCommand(rest, store);
    case "enter":
      return enterGlobalRoleCommand(rest, store);
    default:
      return globalRoleUsage();
  }
}

function addGlobalRoleCommand(args: string[], store: TaskStore): string {
  const [name, ...rest] = args;
  const roleName = parseGlobalRoleName(name);
  const agentId = readOption(rest, "--agent").trim();
  const workspace = readOptionalOption(rest, "--workspace")?.trim() ?? store.getConfig().defaultWorkspace ?? process.cwd();
  const agent = resolveRunner(agentId, store.listCustomRunners());

  assertKnownOptions(rest, new Set(["--agent", "--workspace"]));

  if (agent === null) {
    throwUnsupportedAgent(agentId, store);
  }

  const role = createGlobalRole(roleName, agent, workspace, new Date());
  store.saveGlobalRole(role);

  return renderGlobalRole(`Added role ${role.name}`, role);
}

function listGlobalRoleCommand(store: TaskStore): string {
  const rows = listGlobalRoleRows(store);

  if (rows.length === 0) {
    return "No roles configured.\n";
  }

  return `${rows.map((row) => `${row.name}\t${row.agent}\t${row.workspace}\t${row.kind}`).join("\n")}\n`;
}

function showGlobalRoleCommand(args: string[], store: TaskStore): string {
  const [name] = args;
  const roleName = parseGlobalRoleName(name);
  const role = store.getGlobalRole(roleName);

  if (role === null) {
    if (isSystemRoleName(roleName)) {
      return renderMissingSystemRole(roleName);
    }

    throw roleNotFound(roleName);
  }

  return renderGlobalRole(`Role: ${role.name}`, role);
}

function updateGlobalRoleCommand(args: string[], store: TaskStore): string {
  const [name, ...rest] = args;
  const roleName = parseGlobalRoleName(name);
  const role = store.getGlobalRole(roleName);

  if (role === null) {
    throw roleNotFound(roleName);
  }

  assertKnownOptions(rest, new Set(["--agent", "--workspace"]));

  const agentId = readOptionalOption(rest, "--agent")?.trim();
  const workspace = readOptionalOption(rest, "--workspace")?.trim();
  const patch: Partial<Pick<GlobalRole, "agent" | "command" | "args" | "env" | "workspace">> = {};

  if (agentId !== undefined) {
    if (agentId.length === 0) {
      throw usageError("--agent is required.");
    }

    const agent = resolveRunner(agentId, store.listCustomRunners());

    if (agent === null) {
      throwUnsupportedAgent(agentId, store);
    }

    patch.agent = agent.id;
    patch.command = agent.command;
    patch.args = agent.args;
    patch.env = agent.env;
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

  const updatedRole = updateGlobalRole(role, patch, new Date());
  store.saveGlobalRole(updatedRole);

  return renderGlobalRole(`Updated role ${updatedRole.name}`, updatedRole);
}

function removeGlobalRoleCommand(args: string[], store: TaskStore): string {
  const [name] = args;
  const roleName = parseGlobalRoleName(name);

  if (isSystemRoleName(roleName)) {
    throw usageError(`System role cannot be removed: ${roleName}`);
  }

  if (!store.removeGlobalRole(roleName)) {
    throw roleNotFound(roleName);
  }

  return `Removed role ${roleName}\n`;
}

function enterGlobalRoleCommand(args: string[], store: TaskStore): string {
  const [name] = args;
  const roleName = parseGlobalRoleName(name);
  const role = store.getGlobalRole(roleName);

  if (role === null) {
    throw roleNotFound(roleName);
  }

  const result = spawnSync(role.command, role.args, {
    cwd: role.workspace,
    env: { ...process.env, ...role.env },
    stdio: "inherit"
  });

  if (result.error !== undefined) {
    throw usageError(`Failed to enter role ${roleName}: ${result.error.message}`);
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw usageError(`Role ${roleName} exited with status ${result.status}`);
  }

  return `Exited role ${roleName}\n`;
}

type GlobalRoleRow = {
  name: string;
  agent: string;
  workspace: string;
  kind: string;
};

function listGlobalRoleRows(store: TaskStore): GlobalRoleRow[] {
  const configured = store.listGlobalRoles();
  const rows = new Map<string, GlobalRoleRow>();

  for (const name of SYSTEM_ROLE_NAMES) {
    const role = store.getGlobalRole(name);

    rows.set(name, role === null
      ? { name, agent: "?", workspace: "?", kind: `system:${systemRoleDescription(name)}` }
      : { name: role.name, agent: role.agent, workspace: role.workspace, kind: `system:${systemRoleDescription(name)}` });
  }

  for (const role of configured) {
    if (!rows.has(role.name)) {
      rows.set(role.name, {
        name: role.name,
        agent: role.agent,
        workspace: role.workspace,
        kind: "custom"
      });
    }
  }

  return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function renderGlobalRole(title: string, role: GlobalRole): string {
  return [
    title,
    `Agent: ${role.agent}`,
    `Command: ${role.command}`,
    `Args: ${role.args.join(" ")}`,
    `Env: ${Object.entries(role.env).map(([key, value]) => `${key}=${value}`).join(" ")}`,
    `Workspace: ${role.workspace}`
  ].join("\n").concat("\n");
}

function renderMissingSystemRole(name: string): string {
  return [
    `Role: ${name}`,
    `System: ${systemRoleDescription(name)}`,
    "Agent: ?",
    "Command: ?",
    "Args: ?",
    "Env: ?",
    "Workspace: ?"
  ].join("\n").concat("\n");
}

function parseGlobalRoleName(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw usageError("Role name is required.");
  }

  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw usageError("Role name may only contain letters, numbers, hyphens, and underscores.");
  }

  return value.trim();
}

function readOption(args: string[], name: string): string {
  const index = args.indexOf(name);

  if (index === -1 || args[index + 1] === undefined || args[index + 1].startsWith("--")) {
    throw usageError(`${name} is required.`);
  }

  return args[index + 1];
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

function assertKnownOptions(args: string[], knownOptions: Set<string>): void {
  for (const arg of args) {
    if (arg.startsWith("--") && !knownOptions.has(arg)) {
      throw usageError(`Unsupported option: ${arg}`);
    }
  }
}

function throwUnsupportedAgent(agent: string, store: TaskStore): never {
  const supportedAgents = supportedRunnerIds(store.listCustomRunners());
  const supportedText = supportedAgents.length === 0
    ? "none configured. Run taskmux agent add <agent-id> --command <command>."
    : supportedAgents.join(", ");

  throw usageError(`Unsupported agent: ${agent}\nSupported agents: ${supportedText}`);
}

export function globalRoleUsage(): string {
  return `Role commands:
  taskmux role add <role> --agent <agent-id> [--workspace <path>]
  taskmux role list
  taskmux role show <role>
  taskmux role update <role> [--agent <agent-id>] [--workspace <path>]
  taskmux role remove <role>
  taskmux role enter <role>
`;
}
