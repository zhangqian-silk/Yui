import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runTaskCommand } from "../commands/taskCommands.js";
import { CliError, taskNotFound } from "../errors/cliError.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { TmuxManager } from "../tmux/tmuxManager.js";

export type TaskShellSelectionIo = {
  interactive: boolean;
  width: number;
  write(value: string): void;
  question(prompt: string): Promise<string | undefined>;
};

export type TaskShellArgumentResolver = (
  args: string[],
  io: TaskShellSelectionIo
) => Promise<string[] | null>;

export async function runTaskShell(
  taskId: string,
  store: TaskStore,
  tmux: TmuxManager,
  executeTaskCommand: (args: string[]) => Promise<string> = async (args) => runTaskCommand(args, store, tmux),
  resolveTaskArguments?: TaskShellArgumentResolver
): Promise<void> {
  if (store.runReadSnapshot((snapshot) => snapshot.getTask(taskId)) === null) {
    throw taskNotFound(taskId);
  }

  output.write(await executeTaskCommand(["open", taskId]));

  const rl = createInterface({ input, output });
  const selectionIo: TaskShellSelectionIo = {
    interactive: input.isTTY === true && output.isTTY === true,
    width: output.columns ?? 100,
    write: (value) => output.write(value),
    question: async (prompt) => rl.question(prompt)
  };

  try {
    if (!input.isTTY) {
      for await (const line of rl) {
        output.write(`taskmux ${taskId}> `);
        if (await handleShellLine(taskId, line, executeTaskCommand, resolveTaskArguments, selectionIo) === "exit") {
          break;
        }
      }
      return;
    }

    while (true) {
      const line = await rl.question(`taskmux ${taskId}> `);
      if (await handleShellLine(taskId, line, executeTaskCommand, resolveTaskArguments, selectionIo) === "exit") {
        break;
      }
    }
  } finally {
    rl.close();
  }
}

async function handleShellLine(
  taskId: string,
  line: string,
  executeTaskCommand: (args: string[]) => Promise<string>,
  resolveTaskArguments: TaskShellArgumentResolver | undefined,
  selectionIo: TaskShellSelectionIo
): Promise<"continue" | "exit"> {
  const command = parseCommandLine(line);

  if (command.length === 0) {
    return "continue";
  }

  const [name, ...args] = command;

  if (name === "exit" || name === "quit" || name === "q") {
    return "exit";
  }

  if (name === "help") {
    output.write(shellHelp());
    return "continue";
  }

  try {
    const commandArgs = toTaskCommand(taskId, name, args);
    const resolvedArgs = resolveTaskArguments === undefined
      ? commandArgs
      : await resolveTaskArguments(commandArgs, selectionIo);
    if (resolvedArgs === null) {
      output.write("Cancelled.\n");
      return "continue";
    }
    output.write(await executeTaskCommand(resolvedArgs));
  } catch (error) {
    if (error instanceof CliError) {
      output.write(`${error.code}: ${error.message}\n`);
      return "continue";
    }

    throw error;
  }
  return "continue";
}

function toTaskCommand(taskId: string, name: string, args: string[]): string[] {
  const normalizedName = normalizeShellCommandName(name);

  switch (normalizedName) {
    case "summary":
      return ["open", taskId];
    case "archive":
    case "unarchive":
    case "refresh":
    case "cleanup":
    case "delete":
      return [normalizedName, taskId];
    case "roles":
    case "comments":
    case "events":
    case "activity":
    case "timeline":
      return [normalizedName, taskId];
    case "context":
      return [normalizedName, taskId, ...args];
    case "update":
      return [normalizedName, taskId, ...args];
    case "role":
      return [normalizedName, args[0] ?? "", taskId, ...args.slice(1)];
    case "comment":
      return [normalizedName, taskId, ...args];
    case "assign":
    case "bind":
    case "assign-many":
      return [normalizedName, taskId, ...args];
    case "transcript":
      if (args[0] === "export") {
        return [normalizedName, "export", taskId, ...args.slice(1)];
      }

      return [normalizedName, taskId, ...args];
    case "enter":
    case "tail":
    case "detail":
    case "status":
    case "detach":
    case "stop":
    case "kill":
    case "restart":
      return [normalizedName, taskId, ...args];
    default:
      return [normalizedName, ...args];
  }
}

function normalizeShellCommandName(name: string): string {
  switch (name) {
    case "r":
      return "roles";
    case "c":
      return "comments";
    case "e":
      return "events";
    case "a":
      return "activity";
    case "t":
      return "timeline";
    default:
      return name;
  }
}

function parseCommandLine(line: string): string[] {
  const tokens = line.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];

  return tokens.map((token) => {
    if (
      (token.startsWith("\"") && token.endsWith("\"")) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) {
      return token.slice(1, -1);
    }

    return token;
  });
}

function shellHelp(): string {
  return `Task shell commands:
  summary
  archive
  unarchive
  roles
  r
  refresh
  cleanup
  update [--title <title>] [--description <body>] [--priority low|medium|high|urgent] [--tag <tag> ...] [--due YYYY-MM-DD] [--clear-description] [--clear-priority] [--clear-tags] [--clear-due]
  delete
  comments
  c
  events
  e
  activity
  a
  timeline
  t
  context [--format text|json] [--include-transcripts]
  role update <role> [--agent <agent>] [--workspace <path>]
  role rename <role> <new-role>
  comment <body>
  assign <role> --agent <agent> --workspace <path>
  bind <role> [--as <task-role>] [--workspace <path>]
  assign-many --role <role> ... [--agent <agent>] [--workspace <path>]
  enter <role>
  tail <role>
  detail <role>
  status <role>
  transcript <role>
  transcript export <role> [--format text|json|markdown] [--output <file>]
  detach <role>
  stop <role>
  kill <role>
  restart <role>
  help
  exit
  q
`;
}
