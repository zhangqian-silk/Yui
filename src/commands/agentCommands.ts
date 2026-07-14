import { agentNotFound, usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { createConfiguredAgent } from "../agent/agent.js";
import type { AgentDefinition, AgentEnvironment } from "../agent/agent.js";
import { listAgentDefinitions, resolveAgent } from "../agent/agentRegistry.js";
import type { TaskReader, TaskStore } from "../storage/taskStore.js";

export function runAgentCommand(args: string[], store: TaskStore): string {
  const [command, ...rest] = args;

  switch (command) {
    case "add":
      return addAgentCommand(rest, store);
    case "list":
      return store.runReadSnapshot((snapshot) => listAgentCommand(snapshot));
    case "show":
      return store.runReadSnapshot((snapshot) => showAgentCommand(rest, snapshot));
    case "remove":
      return removeAgentCommand(rest, store);
    default:
      throw usageError(command === undefined ? "Agent command is required." : `Unknown command: agent ${command}`);
  }
}

function addAgentCommand(args: string[], store: TaskStore): string {
  const [id, ...rest] = args;

  if (id === undefined || id.trim().length === 0) {
    throw usageError("Agent id is required.");
  }

  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw usageError("Agent id may only contain letters, numbers, hyphens, and underscores.");
  }

  const command = readOption(rest, "--command").trim();

  if (command.length === 0) {
    throw usageError("--command is required.");
  }

  const agent = createConfiguredAgent(
    id,
    command,
    readRepeatedOption(rest, "--arg"),
    readEnv(rest),
    new Date()
  );
  store.saveConfiguredAgent(agent);

  return renderAgent(`Added agent ${agent.id}`, {
    id: agent.id,
    command: agent.command,
    args: agent.args,
    env: agent.env,
    source: "custom"
  });
}

export function runAgentReadCommand(args: string[], store: TaskReader): string {
  const [command, ...rest] = args;
  if (command === "list") return listAgentCommand(store);
  if (command === "show") return showAgentCommand(rest, store);
  throw usageError(command === undefined ? "Agent command is required." : `Unknown command: agent ${command}`);
}

function listAgentCommand(store: TaskReader): string {
  const agents = listAgentDefinitions(store.listConfiguredAgents());

  if (agents.length === 0) {
    return "No agents configured.\n";
  }

  return `${renderTable(
    "Agents",
    [
      { header: "Agent", minWidth: 5, maxWidth: 24 },
      { header: "Source", minWidth: 6, maxWidth: 12 },
      { header: "Command", minWidth: 7, maxWidth: 80 }
    ],
    agents.map((agent) => [agent.id, agent.source, agentCommandSummary(agent)]),
    defaultTableWidth()
  )}\n`;
}

function showAgentCommand(args: string[], store: TaskReader): string {
  const [id] = args;

  if (id === undefined || id.trim().length === 0) {
    throw usageError("Agent id is required.");
  }

  const agent = resolveAgent(id, store.listConfiguredAgents());

  if (agent === null) {
    throw agentNotFound(id);
  }

  return renderAgent(`Agent: ${agent.id}`, agent);
}

function removeAgentCommand(args: string[], store: TaskStore): string {
  const [id] = args;

  if (id === undefined || id.trim().length === 0) {
    throw usageError("Agent id is required.");
  }

  if (!store.removeConfiguredAgent(id)) {
    throw agentNotFound(id);
  }

  return `Removed agent ${id}\n`;
}

function renderAgent(title: string, agent: AgentDefinition): string {
  return [
    title,
    `Source: ${agent.source}`,
    `Command: ${agent.command}`,
    `Args: ${agent.args.join(" ")}`,
    `Env: ${Object.entries(agent.env).map(([key, value]) => `${key}=${value}`).join(" ")}`
  ].join("\n").concat("\n");
}

function agentCommandSummary(agent: AgentDefinition): string {
  return [agent.command, ...agent.args].join(" ");
}

function readOption(args: string[], name: string): string {
  const index = args.indexOf(name);

  if (index === -1 || args[index + 1] === undefined) {
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

    if (args[index + 1] === undefined) {
      throw usageError(`${name} is required.`);
    }

    values.push(args[index + 1]);
    index += 1;
  }

  return values;
}

function readEnv(args: string[]): AgentEnvironment {
  return Object.fromEntries(readRepeatedOption(args, "--env").map(parseEnv));
}

function parseEnv(value: string): [string, string] {
  const separator = value.indexOf("=");

  if (separator <= 0) {
    throw usageError("--env must use KEY=value.");
  }

  return [value.slice(0, separator), value.slice(separator + 1)];
}
