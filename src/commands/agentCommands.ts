import { agentNotFound, usageError } from "../errors/cliError.js";
import { createCustomRunner } from "../runner/runner.js";
import type { RunnerDefinition, RunnerEnvironment } from "../runner/runner.js";
import { listRunnerDefinitions, resolveRunner } from "../runner/runnerRegistry.js";
import type { TaskStore } from "../storage/taskStore.js";

export function runAgentCommand(args: string[], store: TaskStore): string {
  const [command, ...rest] = args;

  switch (command) {
    case "add":
      return addAgentCommand(rest, store);
    case "list":
      return listAgentCommand(store);
    case "show":
      return showAgentCommand(rest, store);
    case "remove":
      return removeAgentCommand(rest, store);
    default:
      return agentUsage();
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

  const agent = createCustomRunner(
    id,
    command,
    readRepeatedOption(rest, "--arg"),
    readEnv(rest),
    new Date()
  );
  store.saveCustomRunner(agent);

  return renderAgent(`Added agent ${agent.id}`, {
    id: agent.id,
    command: agent.command,
    args: agent.args,
    env: agent.env,
    source: "custom"
  });
}

function listAgentCommand(store: TaskStore): string {
  const agents = listRunnerDefinitions(store.listCustomRunners());

  if (agents.length === 0) {
    return "No agents configured.\n";
  }

  return `${agents.map((agent) => `${agent.id}\t${agent.source}\t${agentCommandSummary(agent)}`).join("\n")}\n`;
}

function showAgentCommand(args: string[], store: TaskStore): string {
  const [id] = args;

  if (id === undefined || id.trim().length === 0) {
    throw usageError("Agent id is required.");
  }

  const agent = resolveRunner(id, store.listCustomRunners());

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

  if (!store.removeCustomRunner(id)) {
    throw agentNotFound(id);
  }

  return `Removed agent ${id}\n`;
}

function renderAgent(title: string, agent: RunnerDefinition): string {
  return [
    title,
    `Source: ${agent.source}`,
    `Command: ${agent.command}`,
    `Args: ${agent.args.join(" ")}`,
    `Env: ${Object.entries(agent.env).map(([key, value]) => `${key}=${value}`).join(" ")}`
  ].join("\n").concat("\n");
}

function agentCommandSummary(agent: RunnerDefinition): string {
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

function readEnv(args: string[]): RunnerEnvironment {
  return Object.fromEntries(readRepeatedOption(args, "--env").map(parseEnv));
}

function parseEnv(value: string): [string, string] {
  const separator = value.indexOf("=");

  if (separator <= 0) {
    throw usageError("--env must use KEY=value.");
  }

  return [value.slice(0, separator), value.slice(separator + 1)];
}

export function agentUsage(): string {
  return `Agent commands:
  taskmux agent add <agent-id> --command <command> [--arg <arg> ...] [--env KEY=value ...]
  taskmux agent list
  taskmux agent show <agent-id>
  taskmux agent remove <agent-id>
`;
}
