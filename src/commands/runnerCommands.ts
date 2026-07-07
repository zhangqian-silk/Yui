import { runnerNotFound, usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { createCustomRunner } from "../runner/runner.js";
import type { RunnerDefinition, RunnerEnvironment } from "../runner/runner.js";
import { listRunnerDefinitions, resolveRunner } from "../runner/runnerRegistry.js";
import type { TaskStore } from "../storage/taskStore.js";

export function runRunnerCommand(args: string[], store: TaskStore): string {
  const [command, ...rest] = args;

  switch (command) {
    case "add":
      return addRunnerCommand(rest, store);
    case "list":
      return listRunnerCommand(store);
    case "show":
      return showRunnerCommand(rest, store);
    case "remove":
      return removeRunnerCommand(rest, store);
    default:
      return runnerUsage();
  }
}

function addRunnerCommand(args: string[], store: TaskStore): string {
  const [id, ...rest] = args;

  if (id === undefined || id.trim().length === 0) {
    throw usageError("Runner id is required.");
  }

  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw usageError("Runner id may only contain letters, numbers, hyphens, and underscores.");
  }

  const command = readOption(rest, "--command").trim();

  if (command.length === 0) {
    throw usageError("--command is required.");
  }

  const runner = createCustomRunner(
    id,
    command,
    readRepeatedOption(rest, "--arg"),
    readEnv(rest),
    new Date()
  );
  store.saveCustomRunner(runner);

  return renderRunner(`Added runner ${runner.id}`, {
    id: runner.id,
    command: runner.command,
    args: runner.args,
    env: runner.env,
    source: "custom"
  });
}

function listRunnerCommand(store: TaskStore): string {
  const runners = listRunnerDefinitions(store.listCustomRunners());

  if (runners.length === 0) {
    return "No runners configured.\n";
  }

  return `${renderTable(
    "Runners",
    [
      { header: "Runner", minWidth: 6, maxWidth: 24 },
      { header: "Source", minWidth: 6, maxWidth: 12 },
      { header: "Command", minWidth: 7, maxWidth: 80 }
    ],
    runners.map((runner) => [runner.id, runner.source, runnerCommandSummary(runner)]),
    defaultTableWidth()
  )}\n`;
}

function showRunnerCommand(args: string[], store: TaskStore): string {
  const [id] = args;

  if (id === undefined || id.trim().length === 0) {
    throw usageError("Runner id is required.");
  }

  const runner = resolveRunner(id, store.listCustomRunners());

  if (runner === null) {
    throw runnerNotFound(id);
  }

  return renderRunner(`Runner: ${runner.id}`, runner);
}

function removeRunnerCommand(args: string[], store: TaskStore): string {
  const [id] = args;

  if (id === undefined || id.trim().length === 0) {
    throw usageError("Runner id is required.");
  }

  if (!store.removeCustomRunner(id)) {
    throw runnerNotFound(id);
  }

  return `Removed runner ${id}\n`;
}

function renderRunner(title: string, runner: RunnerDefinition): string {
  return [
    title,
    `Source: ${runner.source}`,
    `Command: ${runner.command}`,
    `Args: ${runner.args.join(" ")}`,
    `Env: ${Object.entries(runner.env).map(([key, value]) => `${key}=${value}`).join(" ")}`
  ].join("\n").concat("\n");
}

function runnerCommandSummary(runner: RunnerDefinition): string {
  return [runner.command, ...runner.args].join(" ");
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

export function runnerUsage(): string {
  return `Runner commands:
  taskmux runner add <runner-id> --command <command> [--arg <arg> ...] [--env KEY=value ...]
  taskmux runner list
  taskmux runner show <runner-id>
  taskmux runner remove <runner-id>
`;
}
