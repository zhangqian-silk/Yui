#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { runAgentCommand } from "./commands/agentCommands.js";
import { runBoardCommand } from "./commands/boardCommands.js";
import { runConfigCommand } from "./commands/configCommands.js";
import { ensureControllerRunning, runControllerCommand } from "./commands/controllerCommands.js";
import { callController } from "./controller/controller.js";
import { runGlobalRoleCommand } from "./commands/globalRoleCommands.js";
import { runExportCommand, runImportCommand, runPruneCommand } from "./commands/maintenanceCommands.js";
import { runTaskCommand } from "./commands/taskCommands.js";
import { runBackupCommand, runMigrateCommand } from "./commands/migrationCommands.js";
import { runRunnerCommand } from "./commands/runnerCommands.js";
import { runDashboard } from "./dashboard/dashboard.js";
import { getDoctorChecks, renderDoctor, runDoctor } from "./doctor/doctor.js";
import { CliError, dataError, usageError } from "./errors/cliError.js";
import { runSetupCommand, validateSetupInvocation } from "./setup/setupCommand.js";
import { runTaskShell } from "./shell/taskShell.js";
import { FileTaskStore, resolveTaskmuxHome } from "./storage/taskStore.js";
import {
  inspectStorageSchema,
  requireStorageSchema,
  type StorageSchemaState
} from "./storage/storageSchema.js";
import { NodeCommandRunner } from "./tmux/commandRunner.js";
import { TmuxManager } from "./tmux/tmuxManager.js";
import { SYSTEM_ASSISTANT_ROLE, SYSTEM_OPERATOR_ROLE } from "./role/systemRoles.js";
import { prepareGlobalRoleLaunch } from "./assistant/assistantContext.js";
import type { Role } from "./role/role.js";

const VERSION = readPackageVersion();

const usage = `TaskMux ${VERSION}

Local task board for native agent CLI sessions backed by tmux.

Usage:
  taskmux
  taskmux --help
  taskmux --version
  taskmux completion bash|zsh|fish
  taskmux doctor
  taskmux controller start|status [--json]|stop|scan
  taskmux setup [tmux]
  taskmux backup
  taskmux migrate [--dry-run]
  taskmux export --output <file>
  taskmux import <file>
  taskmux prune [--trash] [--backups] [--keep-backups <count>]
  taskmux operator
  taskmux assistant                 # legacy alias
  taskmux board
  taskmux config show
  taskmux config set default-agent <agent-id>
  taskmux config set default-workspace <path>
  taskmux agent add <agent-id> --command <command> [--arg <arg> ...] [--env KEY=value ...]
  taskmux agent list
  taskmux agent show <agent-id>
  taskmux agent remove <agent-id>
  taskmux role add <role> --agent <agent-id> [--workspace <path>] [--description <body>] [--responsibility <body> ...] [--constraint <body> ...] [--expected-output <body>] [--system-prompt <body>] [--skill <skill> ...]
  taskmux role list
  taskmux role show <role>
  taskmux role update <role> [--agent <agent-id>] [--workspace <path>]
  taskmux role remove <role>
  taskmux role enter <role>
  taskmux task create <title> [--template feature|bug|review] [--agent <agent>] [--workspace <path>] [--description <body>] [--priority low|medium|high|urgent] [--tag <tag> ...] [--due YYYY-MM-DD]
  taskmux task update <task-id> [--title <title>] [--description <body>] [--priority low|medium|high|urgent] [--tag <tag> ...] [--due YYYY-MM-DD] [--clear-description] [--clear-priority] [--clear-tags] [--clear-due]
  taskmux task list [--archived true|false] [--tag <tag>] [--priority <priority>] [--search <text>]
  taskmux task board [--archived true|false] [--tag <tag>] [--priority <priority>] [--search <text>] [--with-roles]
  taskmux task show <task-id>
  taskmux task current [<task-id>]
  taskmux task last
  taskmux task clone <task-id> [--title <title>]
  taskmux task archive <task-id> [--reason <body>] [--summary <body>]
  taskmux task unarchive <task-id>
  taskmux task delete <task-id>
  taskmux task restore <task-id>
  taskmux task shell <task-id>
  taskmux task context <task-id> [--format text|json] [--include-transcripts]
  taskmux task assign <task-id> <role> --agent <agent> --workspace <path>
  taskmux task assign-many <task-id> --role <role> ... [--agent <agent>] [--workspace <path>]
  taskmux task role update <task-id> <role> [--agent <agent>] [--workspace <path>]
  taskmux task role rename <task-id> <role> <new-role>
  taskmux task roles <task-id>
  taskmux task enter <task-id> <role>
  taskmux task tail <task-id> <role>
  taskmux task detail <task-id> <role>
  taskmux task status <task-id> <role>
  taskmux task refresh <task-id>
  taskmux task transcript <task-id> <role>
  taskmux task transcript export <task-id> <role> [--format text|json|markdown] [--output <file>]
  taskmux task activity <task-id>
  taskmux task timeline <task-id>
  taskmux task detach <task-id> <role>
  taskmux task stop <task-id> <role>
  taskmux task kill <task-id> <role>
  taskmux task restart <task-id> <role>
  taskmux task cleanup <task-id>
  taskmux task comment <task-id> <body>
  taskmux task comments <task-id>
  taskmux task events <task-id>
  taskmux task topic create <task-id> --id <id> --name <name> --description <body>
  taskmux task topic summarize <task-id> --topic <topic> --summary <body>
  taskmux task input draft|submit <task-id> [body]
  taskmux task cycle create <task-id> --cause <cause> --summary <body>
  taskmux task cycle end <task-id> <cycle-id> --summary <body>
  taskmux task work-item create|update <task-id> ...
  taskmux task role child <task-id> <role> [--parent <role>] ...
  taskmux task dispatch <task-id> <role> --mode new|resume [--work-item <id>] [--topic <topic> ...] --input <body>
  taskmux task yield <task-id> <role> --summary <body>
  taskmux task schedule set <task-id> ...
  taskmux task decision record|supersede <task-id> ...
  taskmux task worktree create <task-id> <role> --path <path> --branch <branch>
`;

const rawArgs = process.argv.slice(2);
const nativeJsonCommand = rawArgs[0] === "controller" && rawArgs[1] === "status";
const jsonOutput = rawArgs.includes("--json") && !nativeJsonCommand;
const args = jsonOutput ? rawArgs.filter((arg) => arg !== "--json") : rawArgs;

main().catch((error: unknown) => {
  if (error instanceof CliError) {
    console.error(jsonOutput
      ? JSON.stringify({ ok: false, code: error.code, message: error.message, details: {} })
      : `${error.code}: ${error.message}`);
    process.exit(error.exitCode);
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(jsonOutput
    ? JSON.stringify({ ok: false, code: "RUNTIME_ERROR", message, details: {} })
    : `RUNTIME_ERROR: ${message}`);
  process.exit(5);
});

async function main(): Promise<void> {
  const rootDir = resolveTaskmuxHome(process.env);

  if (args.includes("--version") || args.includes("-v")) {
    emit(VERSION);
    return;
  }

  if (args.includes("--help") || args.includes("-h") || args.includes("-help")) {
    emit(usage);
    return;
  }

  if (args.length === 0) {
    await runDefaultDashboard(rootDir);
    return;
  }

  if (args[0] === "completion") {
    emit(renderCompletion(args[1]));
    return;
  }

  if (args[0] === "doctor") {
    const storageSchema = inspectStorageSchema(rootDir);
    const store = new FileTaskStore(rootDir);
    const customRunners = canReadStore(storageSchema) ? listCustomRunnersForDoctor(store) : [];

    emit(runDoctor(process.env, new NodeCommandRunner(), customRunners, storageSchema));
    return;
  }

  if (args[0] === "setup") {
    const setupIo = {
      input: process.stdin,
      output: process.stdout,
      forceInteractive: process.env.TASKMUX_SETUP_INTERACTIVE === "1"
    };

    validateSetupInvocation(args.slice(1), setupIo);
    const output = await runSetupCommand(args.slice(1), process.env, new NodeCommandRunner(), setupIo);
    emit(output);
    return;
  }

  if (args[0] === "migrate") {
    emit(runMigrateCommand(rootDir, args.slice(1)));
    return;
  }

  if (args[0] === "backup") {
    requireStorageSchema(rootDir);
    if (process.env.TASKMUX_CONTROLLER_MODE !== "direct") {
      await printControllerCommand(rootDir, "backup", []);
      return;
    }
    emit(runBackupCommand(rootDir));
    return;
  }

  if (args[0] === "controller") {
    requireStorageSchema(rootDir);
    const output = await runControllerCommand(args.slice(1), rootDir, process.env);
    if (output.length > 0) {
      emit(output);
    }
    return;
  }

  if (args[0] === "config") {
    requireStorageSchema(rootDir);
    if (process.env.TASKMUX_CONTROLLER_MODE !== "direct") {
      await printControllerCommand(rootDir, "config", args.slice(1));
      return;
    }
    const store = new FileTaskStore(rootDir);
    emit(runConfigCommand(args.slice(1), store, process.env));
    return;
  }

  if (args[0] === "export") {
    requireStorageSchema(rootDir);
    const store = new FileTaskStore(rootDir);
    emit(runExportCommand(args.slice(1), store));
    return;
  }

  if (args[0] === "import") {
    requireStorageSchema(rootDir);
    if (process.env.TASKMUX_CONTROLLER_MODE !== "direct") {
      await printControllerCommand(rootDir, "import", args.slice(1));
      return;
    }
    const store = new FileTaskStore(rootDir);
    emit(runImportCommand(args.slice(1), store));
    return;
  }

  if (args[0] === "prune") {
    requireStorageSchema(rootDir);
    if (process.env.TASKMUX_CONTROLLER_MODE !== "direct") {
      await printControllerCommand(rootDir, "prune", args.slice(1));
      return;
    }
    emit(runPruneCommand(args.slice(1), rootDir));
    return;
  }

  if (args[0] === "operator" || args[0] === "assistant") {
    if (args.length > 1) {
      throw usageError("Operator usage: taskmux operator");
    }

    requireStorageSchema(rootDir);
    const store = new FileTaskStore(rootDir);
    const roleName = store.getGlobalRole(SYSTEM_OPERATOR_ROLE) !== null
      ? SYSTEM_OPERATOR_ROLE
      : SYSTEM_ASSISTANT_ROLE;
    if (args[0] === "operator" && roleName === SYSTEM_OPERATOR_ROLE) {
      const role = store.getGlobalRole(roleName);
      if (role === null) {
        throw dataError("Operator role is not configured. Run taskmux setup.");
      }
      const prepared = prepareGlobalRoleLaunch(role, { taskmuxHome: rootDir, baseEnv: process.env });
      const tmux = new TmuxManager(process.env.TASKMUX_TMUX_BIN ?? "tmux", new NodeCommandRunner());
      const taskRole: Role = { ...role, status: "idle" };
      tmux.enterRole("operator", taskRole, {
        command: role.command,
        args: prepared.args,
        env: operatorLaunchEnvironment(role.env, prepared.env)
      });
      emit("Detached Operator session");
      return;
    }
    emit(runGlobalRoleCommand(["enter", roleName], store, { taskmuxHome: rootDir }));
    return;
  }

  if (args[0] === "board") {
    requireStorageSchema(rootDir);
    if (process.env.TASKMUX_CONTROLLER_MODE !== "direct") {
      await printControllerCommand(rootDir, "board", []);
      return;
    }
    const store = new FileTaskStore(rootDir);
    emit(runBoardCommand(store));
    return;
  }

  if (args[0] === "agent") {
    requireStorageSchema(rootDir);
    if (process.env.TASKMUX_CONTROLLER_MODE !== "direct") {
      await printControllerCommand(rootDir, "agent", args.slice(1));
      return;
    }
    const store = new FileTaskStore(rootDir);
    emit(runAgentCommand(args.slice(1), store));
    return;
  }

  if (args[0] === "role") {
    requireStorageSchema(rootDir);
    if (args[1] !== "enter" && process.env.TASKMUX_CONTROLLER_MODE !== "direct") {
      await printControllerCommand(rootDir, "role", args.slice(1));
      return;
    }
    const store = new FileTaskStore(rootDir);
    emit(runGlobalRoleCommand(args.slice(1), store, { taskmuxHome: rootDir }));
    return;
  }

  if (args[0] === "runner") {
    requireStorageSchema(rootDir);
    if (process.env.TASKMUX_CONTROLLER_MODE !== "direct") {
      await printControllerCommand(rootDir, "runner", args.slice(1));
      return;
    }
    const store = new FileTaskStore(rootDir);
    emit(runRunnerCommand(args.slice(1), store));
    return;
  }

  if (args[0] === "task") {
    requireStorageSchema(rootDir);
    const store = new FileTaskStore(rootDir);
    const tmux = new TmuxManager(process.env.TASKMUX_TMUX_BIN ?? "tmux", new NodeCommandRunner());
    const taskArgs = resolveTaskCommandScope(args.slice(1), process.env);

    if (taskArgs[0] === "shell") {
      const taskId = taskArgs[1];

      if (taskId === undefined || taskId.trim().length === 0) {
        throw usageError("Task id is required.");
      }

      if (process.env.TASKMUX_CONTROLLER_MODE === "direct") {
        await runTaskShell(taskId, store, tmux);
        return;
      }
      const discovery = await ensureControllerRunning(rootDir, process.env);
      await runTaskShell(taskId, store, tmux, async (commandArgs) => {
        if (commandArgs[0] === "enter") {
          return attachTaskRoleThroughController(commandArgs, store, tmux, discovery);
        }
        const result = await callController(
          discovery,
          "task.command",
          randomUUID(),
          { args: commandArgs }
        ) as { output: string };
        return result.output;
      });
      return;
    }

    if (taskArgs[0] === "enter" && process.env.TASKMUX_CONTROLLER_MODE !== "direct") {
      const discovery = await ensureControllerRunning(rootDir, process.env);
      emit(await attachTaskRoleThroughController(taskArgs, store, tmux, discovery));
      return;
    }

    if (taskArgs[0] !== "enter" && process.env.TASKMUX_CONTROLLER_MODE !== "direct") {
      const discovery = await ensureControllerRunning(rootDir, process.env);
      const result = await callController(
        discovery,
        "task.command",
        randomUUID(),
        { args: taskArgs }
      ) as { output: string };
      if (result.output.length > 0) {
        emit(result.output);
      }
      return;
    }

    emit(runTaskCommand(taskArgs, store, tmux));
    return;
  }

  emit(usage);
}

async function attachTaskRoleThroughController(
  commandArgs: string[],
  store: FileTaskStore,
  tmux: TmuxManager,
  discovery: Awaited<ReturnType<typeof ensureControllerRunning>>
): Promise<string> {
  const [, taskId, roleName] = commandArgs;
  if (taskId === undefined || roleName === undefined) {
    return runTaskCommand(commandArgs, store, tmux);
  }
  const output = runTaskCommand(commandArgs, store, tmux, { persistAttachStatus: false });
  await callController(discovery, "task.attach-complete", randomUUID(), { taskId, roleName });
  return output;
}

function emit(output: string): void {
  const normalized = output.trimEnd();
  console.log(jsonOutput ? JSON.stringify({ ok: true, output: normalized }) : normalized);
}

function resolveTaskCommandScope(commandArgs: string[], env: NodeJS.ProcessEnv): string[] {
  const taskId = env.TASKMUX_TASK_ID?.trim();
  const roleName = env.TASKMUX_ROLE?.trim();
  if (taskId === undefined || taskId.length === 0 || commandArgs.length === 0) {
    return commandArgs;
  }

  const [command, ...rest] = commandArgs;
  const hasTaskId = (value: string | undefined): boolean => value === taskId || /^task-\d+$/.test(value ?? "");
  const taskOnlyCommands = new Set([
    "show", "archive", "unarchive", "open", "context", "delete", "roles", "comments",
    "events", "activity", "timeline", "refresh", "cleanup", "wake", "shell"
  ]);

  if (taskOnlyCommands.has(command) && !hasTaskId(rest[0])) {
    return [command, taskId, ...rest];
  }
  if (command === "comment" && !hasTaskId(rest[0])) {
    return [command, taskId, ...rest];
  }
  if (command === "yield") {
    if (!hasTaskId(rest[0])) {
      return [command, taskId, ...(roleName === undefined || roleName.length === 0 ? [] : [roleName]), ...rest];
    }
    if ((rest[1] === undefined || rest[1].startsWith("--")) && roleName !== undefined && roleName.length > 0) {
      return [command, rest[0], roleName, ...rest.slice(1)];
    }
  }
  if (command === "dispatch" && !hasTaskId(rest[0])) {
    return [command, taskId, ...rest];
  }
  if (command === "session" && !hasTaskId(rest[1])) {
    return [
      command,
      rest[0] ?? "",
      taskId,
      ...(roleName === undefined || roleName.length === 0 ? [] : [roleName]),
      ...rest.slice(1)
    ];
  }

  const nestedTaskCommands = new Set([
    "role", "topic", "input", "cycle", "work-item", "schedule", "brief",
    "milestone", "decision", "worktree"
  ]);
  if (nestedTaskCommands.has(command) && !hasTaskId(rest[1])) {
    return [command, rest[0] ?? "", taskId, ...rest.slice(1)];
  }

  return commandArgs;
}

async function printControllerCommand(rootDir: string, group: string, commandArgs: string[]): Promise<void> {
  const discovery = await ensureControllerRunning(rootDir, process.env);
  const result = await callController(
    discovery,
    "command.execute",
    randomUUID(),
    { group, args: commandArgs }
  ) as { output: string };
  if (result.output.length > 0) {
    emit(result.output);
  }
}

function operatorLaunchEnvironment(
  roleEnvironment: Record<string, string>,
  preparedEnvironment: NodeJS.ProcessEnv
): Record<string, string> {
  const result = { ...roleEnvironment };
  for (const key of [
    "TASKMUX_HOME",
    "TASKMUX_ROLE",
    "TASKMUX_WORKSPACE",
    "TASKMUX_OPERATOR_CONTEXT",
    "TASKMUX_ASSISTANT_CONTEXT"
  ]) {
    const value = preparedEnvironment[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

async function runDefaultDashboard(rootDir: string): Promise<void> {
  const commandRunner = new NodeCommandRunner();
  const storageSchema = inspectStorageSchema(rootDir);
  const storeForDoctor = new FileTaskStore(rootDir);
  const customRunners = canReadStore(storageSchema) ? listCustomRunnersForDoctor(storeForDoctor) : [];
  const checks = getDoctorChecks(process.env, commandRunner, customRunners, storageSchema);
  const failedChecks = checks.filter((check) => check.status !== "ok");

  process.stdout.write(renderDoctor(checks));

  if (failedChecks.length > 0) {
    throw dataError(`Doctor checks failed: ${failedChecks.map((check) => `${check.name}=${check.status}`).join(", ")}`);
  }

  requireStorageSchema(rootDir);
  const store = new FileTaskStore(rootDir);
  const tmux = new TmuxManager(process.env.TASKMUX_TMUX_BIN ?? "tmux", commandRunner);

  if (process.env.TASKMUX_CONTROLLER_MODE === "direct") {
    await runDashboard(store, tmux);
    return;
  }
  const discovery = await ensureControllerRunning(rootDir, process.env);
  await runDashboard(store, tmux, async (commandArgs) => {
    if (commandArgs[0] === "enter") {
      return attachTaskRoleThroughController(commandArgs, store, tmux, discovery);
    }
    const result = await callController(
      discovery,
      "task.command",
      randomUUID(),
      { args: commandArgs }
    ) as { output: string };
    return result.output;
  });
}

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };

    if (typeof packageJson.version === "string" && packageJson.version.length > 0) {
      return packageJson.version;
    }
  } catch {
    // Keep the CLI usable even if package metadata is unavailable.
  }

  return "0.0.0";
}

function canReadStore(state: StorageSchemaState): boolean {
  return state.status === "current";
}

function listCustomRunnersForDoctor(store: FileTaskStore) {
  try {
    return store.listCustomRunners();
  } catch {
    return [];
  }
}

function renderCompletion(shell: string | undefined): string {
  const commands = [
    "doctor", "setup", "backup", "migrate", "export", "import", "prune", "operator", "assistant", "board", "config", "agent", "role", "task", "completion",
    "create", "update", "list", "board", "show", "archive", "unarchive", "delete", "restore",
    "shell", "context", "assign", "assign-many", "role", "roles", "enter", "tail", "detail", "status",
    "refresh", "transcript", "activity", "timeline", "detach", "stop", "kill", "restart", "cleanup",
    "comment", "comments", "events", "current", "last", "clone", "topic", "input", "draft", "submit", "cycle", "work-item", "wake", "session", "dispatch", "yield", "schedule", "brief", "milestone", "decision", "worktree"
  ].join(" ");

  if (shell === "bash") {
    return `_taskmux() {
  COMPREPLY=( $(compgen -W "${commands}" -- "\${COMP_WORDS[COMP_CWORD]}") )
}
complete -F _taskmux taskmux
`;
  }

  if (shell === "zsh") {
    return `#compdef taskmux
_arguments '*::taskmux command:(${commands})'
`;
  }

  if (shell === "fish") {
    return commands
      .split(" ")
      .map((command) => `complete -c taskmux -f -a ${command}`)
      .join("\n")
      .concat("\n");
  }

  throw usageError("Completion shell must be one of bash, zsh, fish.");
}
