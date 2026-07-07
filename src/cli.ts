#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { runAgentCommand } from "./commands/agentCommands.js";
import { runBoardCommand } from "./commands/boardCommands.js";
import { runConfigCommand } from "./commands/configCommands.js";
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

const VERSION = readPackageVersion();

const usage = `TaskMux ${VERSION}

Local task board for native agent CLI sessions backed by tmux.

Usage:
  taskmux
  taskmux --help
  taskmux --version
  taskmux completion bash|zsh|fish
  taskmux doctor
  taskmux setup [tmux]
  taskmux backup
  taskmux migrate [--dry-run]
  taskmux export --output <file>
  taskmux import <file>
  taskmux prune [--trash] [--backups] [--keep-backups <count>]
  taskmux assistant
  taskmux board
  taskmux config show
  taskmux config set default-agent <agent-id>
  taskmux config set default-workspace <path>
  taskmux agent add <agent-id> --command <command> [--arg <arg> ...] [--env KEY=value ...]
  taskmux agent list
  taskmux agent show <agent-id>
  taskmux agent remove <agent-id>
  taskmux role add <role> --agent <agent-id> [--workspace <path>]
  taskmux role list
  taskmux role show <role>
  taskmux role update <role> [--agent <agent-id>] [--workspace <path>]
  taskmux role remove <role>
  taskmux role enter <role>
  taskmux task create <title> [--template feature|bug|review] [--agent <agent>] [--workspace <path>] [--description <body>] [--priority low|medium|high|urgent] [--tag <tag> ...] [--due YYYY-MM-DD]
  taskmux task update <task-id> [--title <title>] [--description <body>] [--priority low|medium|high|urgent] [--tag <tag> ...] [--due YYYY-MM-DD] [--clear-description] [--clear-priority] [--clear-tags] [--clear-due]
  taskmux task list [--status <status>] [--tag <tag>] [--priority <priority>] [--search <text>]
  taskmux task board [--status <status>] [--tag <tag>] [--priority <priority>] [--search <text>] [--with-roles]
  taskmux task show <task-id>
  taskmux task current [<task-id>]
  taskmux task last
  taskmux task clone <task-id> [--title <title>]
  taskmux task start <task-id>
  taskmux task done <task-id>
  taskmux task archive <task-id>
  taskmux task reopen <task-id>
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

Role, tmux, and agent commands are defined in docs/requirements.md.
`;

const args = process.argv.slice(2);

main().catch((error: unknown) => {
  if (error instanceof CliError) {
    console.error(`${error.code}: ${error.message}`);
    process.exit(error.exitCode);
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(`RUNTIME_ERROR: ${message}`);
  process.exit(5);
});

async function main(): Promise<void> {
  const rootDir = resolveTaskmuxHome(process.env);

  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return;
  }

  if (args.includes("--help") || args.includes("-h") || args.includes("-help")) {
    console.log(usage);
    return;
  }

  if (args.length === 0) {
    await runDefaultDashboard(rootDir);
    return;
  }

  if (args[0] === "completion") {
    console.log(renderCompletion(args[1]).trimEnd());
    return;
  }

  if (args[0] === "doctor") {
    const storageSchema = inspectStorageSchema(rootDir);
    const store = new FileTaskStore(rootDir);
    const customRunners = canReadStore(storageSchema) ? listCustomRunnersForDoctor(store) : [];

    console.log(runDoctor(process.env, new NodeCommandRunner(), customRunners, storageSchema).trimEnd());
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
    console.log(output.trimEnd());
    return;
  }

  if (args[0] === "migrate") {
    console.log(runMigrateCommand(rootDir, args.slice(1)).trimEnd());
    return;
  }

  if (args[0] === "backup") {
    requireStorageSchema(rootDir);
    console.log(runBackupCommand(rootDir).trimEnd());
    return;
  }

  if (args[0] === "config") {
    requireStorageSchema(rootDir);
    const store = new FileTaskStore(rootDir);
    console.log(runConfigCommand(args.slice(1), store, process.env).trimEnd());
    return;
  }

  if (args[0] === "export") {
    requireStorageSchema(rootDir);
    const store = new FileTaskStore(rootDir);
    console.log(runExportCommand(args.slice(1), store).trimEnd());
    return;
  }

  if (args[0] === "import") {
    requireStorageSchema(rootDir);
    const store = new FileTaskStore(rootDir);
    console.log(runImportCommand(args.slice(1), store).trimEnd());
    return;
  }

  if (args[0] === "prune") {
    requireStorageSchema(rootDir);
    console.log(runPruneCommand(args.slice(1), rootDir).trimEnd());
    return;
  }

  if (args[0] === "assistant") {
    if (args.length > 1) {
      throw usageError("Assistant usage: taskmux assistant");
    }

    requireStorageSchema(rootDir);
    const store = new FileTaskStore(rootDir);
    console.log(runGlobalRoleCommand(["enter", "assistant"], store, { taskmuxHome: rootDir }).trimEnd());
    return;
  }

  if (args[0] === "board") {
    requireStorageSchema(rootDir);
    const store = new FileTaskStore(rootDir);
    console.log(runBoardCommand(store).trimEnd());
    return;
  }

  if (args[0] === "agent") {
    requireStorageSchema(rootDir);
    const store = new FileTaskStore(rootDir);
    console.log(runAgentCommand(args.slice(1), store).trimEnd());
    return;
  }

  if (args[0] === "role") {
    requireStorageSchema(rootDir);
    const store = new FileTaskStore(rootDir);
    console.log(runGlobalRoleCommand(args.slice(1), store, { taskmuxHome: rootDir }).trimEnd());
    return;
  }

  if (args[0] === "runner") {
    requireStorageSchema(rootDir);
    const store = new FileTaskStore(rootDir);
    console.log(runRunnerCommand(args.slice(1), store).trimEnd());
    return;
  }

  if (args[0] === "task") {
    requireStorageSchema(rootDir);
    const store = new FileTaskStore(rootDir);
    const tmux = new TmuxManager(process.env.TASKMUX_TMUX_BIN ?? "tmux", new NodeCommandRunner());

    if (args[1] === "shell") {
      const taskId = args[2];

      if (taskId === undefined || taskId.trim().length === 0) {
        throw usageError("Task id is required.");
      }

      await runTaskShell(taskId, store, tmux);
      return;
    }

    console.log(runTaskCommand(args.slice(1), store, tmux).trimEnd());
    return;
  }

  console.log(usage);
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

  await runDashboard(store, tmux);
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
    "doctor", "setup", "backup", "migrate", "export", "import", "prune", "assistant", "board", "config", "agent", "role", "task", "completion",
    "create", "update", "list", "board", "show", "start", "done", "archive", "reopen", "delete", "restore",
    "shell", "context", "assign", "assign-many", "role", "roles", "enter", "tail", "detail", "status",
    "refresh", "transcript", "activity", "timeline", "detach", "stop", "kill", "restart", "cleanup",
    "comment", "comments", "events", "current", "last", "clone"
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
