import { spawnSync } from "node:child_process";
import { prepareGlobalRoleLaunch } from "../operator/operatorContext.js";
import { roleNotFound, usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { createGlobalRole, updateGlobalRole } from "../role/role.js";
import type { GlobalRole } from "../role/role.js";
import { isSystemRoleName, SYSTEM_ROLE_NAMES, systemRoleDescription } from "../role/systemRoles.js";
import { resolveAgent, supportedAgentIds } from "../agent/agentRegistry.js";
import type { TaskStore } from "../storage/taskStore.js";

type GlobalRoleCommandOptions = {
  taskmuxHome?: string;
  env?: NodeJS.ProcessEnv;
};

export function runGlobalRoleCommand(
  args: string[],
  store: TaskStore,
  options: GlobalRoleCommandOptions = {}
): string {
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
      return enterGlobalRoleCommand(rest, store, options);
    default:
      throw usageError(command === undefined ? "Role command is required." : `Unknown command: role ${command}`);
  }
}

function addGlobalRoleCommand(args: string[], store: TaskStore): string {
  const [name, ...rest] = args;
  const roleName = parseGlobalRoleName(name);
  const agentId = readOption(rest, "--agent").trim();
  const workspace = readOptionalOption(rest, "--workspace")?.trim() ?? store.getConfig().defaultWorkspace ?? process.cwd();
  const agent = resolveAgent(agentId, store.listConfiguredAgents());

  assertKnownOptions(rest, new Set([
    "--agent", "--workspace", "--description", "--responsibility", "--constraint",
    "--expected-output", "--system-prompt", "--skill"
  ]));

  if (agent === null) {
    throwUnsupportedAgent(agentId, store);
  }

  const role = createGlobalRole(roleName, agent, workspace, new Date(), {
    description: readOptionalOption(rest, "--description")?.trim(),
    responsibilities: readRepeatedOption(rest, "--responsibility"),
    constraints: readRepeatedOption(rest, "--constraint"),
    expectedOutput: readOptionalOption(rest, "--expected-output")?.trim(),
    systemPrompt: readOptionalOption(rest, "--system-prompt")?.trim(),
    skills: readRepeatedOption(rest, "--skill")
  });
  store.saveGlobalRole(role);

  return renderGlobalRole(`Added role ${role.name}`, role);
}

function listGlobalRoleCommand(store: TaskStore): string {
  const rows = listGlobalRoleRows(store);

  if (rows.length === 0) {
    return "No roles configured.\n";
  }

  return `${renderTable(
    "Roles",
    [
      { header: "Role", minWidth: 4, maxWidth: 24 },
      { header: "Agent", minWidth: 5, maxWidth: 20 },
      { header: "Workspace", minWidth: 9, maxWidth: 54 },
      { header: "Kind", minWidth: 6, maxWidth: 34 }
    ],
    rows.map((row) => [row.name, row.agent, row.workspace, row.kind]),
    defaultTableWidth()
  )}\n`;
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

    const agent = resolveAgent(agentId, store.listConfiguredAgents());

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

function enterGlobalRoleCommand(
  args: string[],
  store: TaskStore,
  options: GlobalRoleCommandOptions
): string {
  const [name] = args;
  const roleName = parseGlobalRoleName(name);
  const role = store.getGlobalRole(roleName);

  if (role === null) {
    throw roleNotFound(roleName);
  }

  const launch = prepareGlobalRoleLaunch(role, {
    taskmuxHome: options.taskmuxHome,
    baseEnv: options.env
  });

  const result = spawnSync(role.command, launch.args, {
    cwd: role.workspace,
    env: launch.env,
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
    `Workspace: ${role.workspace}`,
    `Description: ${role.description ?? ""}`,
    `Responsibilities: ${(role.responsibilities ?? []).join("; ")}`,
    `Constraints: ${(role.constraints ?? []).join("; ")}`,
    `Expected output: ${role.expectedOutput ?? ""}`,
    `System prompt: ${role.systemPrompt ?? ""}`,
    `Skills: ${(role.skills ?? []).join(", ")}`
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

function readRepeatedOption(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1] !== undefined && !args[index + 1].startsWith("--")) {
      values.push(args[index + 1].trim());
      index += 1;
    }
  }
  return values;
}

function assertKnownOptions(args: string[], knownOptions: Set<string>): void {
  for (const arg of args) {
    if (arg.startsWith("--") && !knownOptions.has(arg)) {
      throw usageError(`Unsupported option: ${arg}`);
    }
  }
}

function throwUnsupportedAgent(agent: string, store: TaskStore): never {
  const supportedAgents = supportedAgentIds(store.listConfiguredAgents());
  const supportedText = supportedAgents.length === 0
    ? "none configured. Run taskmux agent add <agent-id> --command <command>."
    : supportedAgents.join(", ");

  throw usageError(`Unsupported agent: ${agent}\nSupported agents: ${supportedText}`);
}
