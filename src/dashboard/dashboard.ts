import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runTaskCommand, runTaskReadSnapshot } from "../commands/taskCommands.js";
import { CliError, usageError } from "../errors/cliError.js";
import type { TaskReader, TaskStore } from "../storage/taskStore.js";
import type { TmuxManager } from "../tmux/tmuxManager.js";

export async function runDashboard(
  store: TaskStore,
  tmux: TmuxManager,
  executeTaskCommand: (args: string[]) => Promise<string> = async (args) => runTaskCommand(args, store, tmux)
): Promise<void> {
  output.write(renderDashboard(store, tmux));

  const rl = createInterface({ input, output });

  try {
    if (!input.isTTY) {
      for await (const line of rl) {
        output.write("taskmux> ");
        if (await handleDashboardLine(line, store, tmux, executeTaskCommand) === "exit") {
          break;
        }
      }
      return;
    }

    while (true) {
      const line = await rl.question("taskmux> ");
      if (await handleDashboardLine(line, store, tmux, executeTaskCommand) === "exit") {
        break;
      }
    }
  } finally {
    rl.close();
  }
}

function renderDashboard(store: TaskStore, tmux: TmuxManager): string {
  return store.runReadSnapshot((snapshot) => renderDashboardSnapshot(snapshot, tmux));
}

function renderDashboardSnapshot(store: TaskReader, tmux: TmuxManager): string {
  return [
    "TaskMux dashboard",
    runTaskReadSnapshot(["current"], store).trimEnd(),
    runTaskReadSnapshot(["last"], store).trimEnd(),
    "",
    "Board",
    runTaskReadSnapshot(["board", "--with-roles"], store).trimEnd(),
    "",
    "Type help for commands. Type q to quit."
  ].join("\n").concat("\n");
}

async function handleDashboardLine(
  line: string,
  store: TaskStore,
  tmux: TmuxManager,
  executeTaskCommand: (args: string[]) => Promise<string>
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
    output.write(dashboardHelp());
    return "continue";
  }

  if (name === "dashboard" || name === "home" || name === "refresh" || name === "r") {
    output.write(renderDashboard(store, tmux));
    return "continue";
  }

  try {
    const taskCommand = store.runReadSnapshot((snapshot) => toTaskCommand(name, args, snapshot));
    output.write(await executeTaskCommand(taskCommand));
  } catch (error) {
    if (error instanceof CliError) {
      output.write(`${error.code}: ${error.message}\n`);
      return "continue";
    }
    output.write(`RUNTIME_ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    return "continue";
  }

  return "continue";
}

function toTaskCommand(name: string, args: string[], store: TaskReader): string[] {
  const normalizedName = normalizeDashboardCommandName(name);

  if (normalizedName === "task") {
    return args;
  }

  switch (normalizedName) {
    case "board":
      return args.includes("--with-roles") ? [normalizedName, ...args] : [normalizedName, "--with-roles", ...args];
    case "list":
    case "current":
    case "last":
    case "create":
    case "clone":
    case "restore":
      return [normalizedName, ...args];
    case "open":
    case "show":
    case "context":
    case "roles":
    case "comments":
    case "events":
    case "activity":
    case "timeline":
    case "archive":
    case "unarchive":
    case "cleanup":
    case "delete":
      return [normalizedName, ...withDefaultTaskId(args, store)];
    case "update":
      return [normalizedName, ...withDefaultTaskId(args, store)];
    case "comment":
      return [normalizedName, ...withDefaultTaskIdUnlessTaskExists(args, store)];
    case "bind":
      return [normalizedName, ...withDefaultTaskIdForRoleArgs(args, store)];
    case "assign":
      if (args[0] !== undefined && args[1] !== undefined && isExplicitTaskId(args[0], store)) {
        return [normalizedName, ...args];
      }

      return [normalizedName, requireCurrentTaskId(store), ...args];
    case "assign-many":
      return [normalizedName, ...withDefaultTaskId(args, store)];
    case "role":
      if (args.length > 0 && (args[0] === "update" || args[0] === "rename")) {
        return [normalizedName, args[0], ...withDefaultTaskIdForRoleArgs(args.slice(1), store)];
      }

      return [normalizedName, ...args];
    case "transcript":
      if (args[0] === "export") {
        return [normalizedName, "export", ...withDefaultTaskIdForRoleArgs(args.slice(1), store)];
      }

      return [normalizedName, ...withDefaultTaskIdForRoleArgs(args, store)];
    case "enter":
    case "tail":
    case "detail":
    case "status":
    case "detach":
    case "stop":
    case "kill":
    case "restart":
      return [normalizedName, ...withDefaultTaskIdForRoleArgs(args, store)];
    default:
      return [normalizedName, ...args];
  }
}

function normalizeDashboardCommandName(name: string): string {
  switch (name) {
    case "b":
      return "board";
    case "ls":
      return "list";
    case "o":
      return "open";
    case "c":
      return "current";
    default:
      return name;
  }
}

function withDefaultTaskId(args: string[], store: TaskReader): string[] {
  if (args[0] !== undefined && !args[0].startsWith("--")) {
    return args;
  }

  const taskId = store.getConfig().currentTaskId;

  if (taskId === undefined || taskId.length === 0) {
    throw usageError("Task id is required. Set one with current <task-id> or pass <task-id>.");
  }

  return [taskId, ...args];
}

function withDefaultTaskIdForRoleArgs(args: string[], store: TaskReader): string[] {
  if (args[0] !== undefined && args[1] !== undefined && isExplicitTaskId(args[0], store)) {
    return args;
  }

  return [requireCurrentTaskId(store), ...args];
}

function withDefaultTaskIdUnlessTaskExists(args: string[], store: TaskReader): string[] {
  if (args[0] !== undefined && isExplicitTaskId(args[0], store)) {
    return args;
  }

  return [requireCurrentTaskId(store), ...args];
}

function isExplicitTaskId(value: string, store: TaskReader): boolean {
  return store.getTask(value) !== null || /^task-\d+$/.test(value);
}

function requireCurrentTaskId(store: TaskReader): string {
  const taskId = store.getConfig().currentTaskId;

  if (taskId === undefined || taskId.length === 0) {
    throw usageError("Task id is required. Set one with current <task-id> or pass <task-id>.");
  }

  return taskId;
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

function dashboardHelp(): string {
  return `TaskMux dashboard commands:
  dashboard
  r
  board [--archived true|false] [--tag <tag>] [--priority <priority>] [--search <text>]
  b
  list [--archived true|false] [--tag <tag>] [--priority <priority>] [--search <text>]
  ls
  current [<task-id>]
  c [<task-id>]
  last
  create <title> [--agent <agent>] [--workspace <path>] [--template feature|bug|review]
  open [<task-id>]
  o [<task-id>]
  show [<task-id>]
  update [<task-id>] [--title <title>] [--description <body>] [--priority low|medium|high|urgent] [--tag <tag> ...] [--due YYYY-MM-DD]
  archive [<task-id>]
  unarchive [<task-id>]
  roles [<task-id>]
  bind [<task-id>] <role> [--as <task-role>] [--workspace <path>]
  enter [<task-id>] <role>
  context [<task-id>] [--format text|json] [--include-transcripts]
  comments [<task-id>]
  events [<task-id>]
  task <task command...>
  help
  exit
  q
`;
}
