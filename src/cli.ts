#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { runAgentCommand } from "./commands/agentCommands.js";
import { runBackupCommand } from "./commands/backupCommands.js";
import { runConfigCommand } from "./commands/configCommands.js";
import { ensureControllerRunning, runControllerCommand } from "./commands/controllerCommands.js";
import { callController } from "./controller/controller.js";
import { runGlobalRoleCommand } from "./commands/globalRoleCommands.js";
import { runExportCommand, runImportCommand, runPruneCommand } from "./commands/maintenanceCommands.js";
import { runTaskCommand } from "./commands/taskCommands.js";
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
import { NodeCommandExecutor } from "./tmux/commandExecutor.js";
import { TmuxManager } from "./tmux/tmuxManager.js";
import { SYSTEM_OPERATOR_ROLE } from "./role/systemRoles.js";
import { prepareGlobalRoleLaunch } from "./operator/operatorContext.js";
import type { Role } from "./role/role.js";
import { renderCommandHelp } from "./cli/helpRenderer.js";
import { routeInvocation } from "./cli/invocationRouter.js";
import { runUpdateCommand } from "./cli/updateCommand.js";
import { renderCompletion, type CliIdentity } from "./cli/completion.js";
import { runCompletionWizard } from "./completion/completionWizard.js";
import { allowsInteractiveSelection, resolveInteractiveArguments } from "./cli/interactiveSelection.js";

const VERSION = readPackageVersion();

const rawArgs = process.argv.slice(2);
const nativeJsonCommand = rawArgs[0] === "controller" && rawArgs[1] === "status";
const jsonOutput = rawArgs.includes("--json") && !nativeJsonCommand;
const args = jsonOutput ? rawArgs.filter((arg) => arg !== "--json") : rawArgs;

main().catch((error: unknown) => {
  if (error instanceof CliError) {
    const rendered = jsonOutput
      ? JSON.stringify({ ok: false, code: error.code, message: error.message, details: {} })
      : `${error.code}: ${error.message}${error.helpText === undefined ? "" : `\n\n${error.helpText.trimEnd()}`}`;
    console.error(rendered);
    process.exit(error.exitCode);
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(jsonOutput
    ? JSON.stringify({ ok: false, code: "RUNTIME_ERROR", message, details: {} })
    : `RUNTIME_ERROR: ${message}`);
  process.exit(5);
});

async function main(): Promise<void> {
  if (args[0] === "version" && args.length === 1) {
    emit(VERSION);
    return;
  }

  const invocation = routeInvocation(args);
  if (invocation.kind === "help") {
    emit(renderCommandHelp(invocation.node, VERSION));
    return;
  }
  if (invocation.kind === "path-error") {
    throw usageError(
      `Unknown command: ${invocation.typedPath}`,
      renderCommandHelp(invocation.helpNode, VERSION)
    );
  }
  if (invocation.kind === "incomplete") {
    throw usageError(
      `Command required after: ${invocation.typedPath}`,
      `${renderCommandHelp(invocation.helpNode, VERSION)}\nRun \`taskmux help ${invocation.typedPath}\` for this command group.\n`
    );
  }

  if (args[0] === "version") {
    throw usageError("Version usage: taskmux version");
  }

  if (args[0] === "update") {
    if (jsonOutput) {
      throw usageError("Update does not support --json.");
    }
    if (args.length !== 1) {
      throw usageError("Update usage: taskmux update");
    }
    process.exitCode = runUpdateCommand();
    return;
  }

  const rootDir = resolveTaskmuxHome(process.env);

  if (args.length === 0) {
    await runDefaultDashboard(rootDir);
    return;
  }

  if (args[0] === "completion") {
    if (args[1] === "install" || args[1] === "uninstall") {
      if (args.length !== 2) {
        throw usageError(`Completion ${args[1]} usage: taskmux completion ${args[1]}`);
      }
      if (jsonOutput) {
        throw usageError(`Completion ${args[1]} does not support --json.`);
      }
      if (process.stdin.isTTY !== true && process.env.TASKMUX_SETUP_INTERACTIVE !== "1") {
        throw usageError(`Completion ${args[1]} requires an interactive terminal.`);
      }
      requireStorageSchema(rootDir);
      const store = new FileTaskStore(rootDir);
      const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
      try {
        const iterator = process.stdin.isTTY === true ? undefined : readline[Symbol.asyncIterator]();
        const question = process.stdin.isTTY === true
          ? (prompt: string) => readline.question(prompt)
          : async (prompt: string) => {
              process.stdout.write(prompt);
              const next = await iterator?.next();
              return next?.done === true || next === undefined ? "skip" : next.value;
            };
        emit(await runCompletionWizard(
          args[1],
          store,
          process.env,
          resolveCliIdentity(process.env),
          question,
          { width: process.stdout.columns }
        ));
      } finally {
        readline.close();
      }
      return;
    }
    emit(renderCompletion(args[1], resolveCliIdentity(process.env)));
    return;
  }

  if (args[0] === "doctor") {
    const storageSchema = inspectStorageSchema(rootDir);
    const store = new FileTaskStore(rootDir);
    const agents = canReadStore(storageSchema) ? listConfiguredAgentsForDoctor(store) : [];

    emit(runDoctor(process.env, new NodeCommandExecutor(), agents, storageSchema));
    return;
  }

  if (args[0] === "setup") {
    if (jsonOutput) {
      throw usageError("Setup does not support --json.");
    }
    const setupIo = {
      input: process.stdin,
      output: process.stdout,
      forceInteractive: process.env.TASKMUX_SETUP_INTERACTIVE === "1"
    };

    validateSetupInvocation(args.slice(1), setupIo);
    const output = await runSetupCommand(args.slice(1), process.env, new NodeCommandExecutor(), setupIo);
    emit(output);
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
    const discovery = process.env.TASKMUX_CONTROLLER_MODE === "direct"
      ? undefined
      : await ensureControllerRunning(rootDir, process.env);
    const store = new FileTaskStore(rootDir);
    const resolvedArgs = await resolveTerminalArguments(args, invocation.node, store);
    if (resolvedArgs === null) {
      emit("Cancelled.");
      return;
    }
    if (discovery !== undefined) {
      await printControllerCommand(rootDir, "config", resolvedArgs.slice(1), discovery);
      return;
    }
    emit(runConfigCommand(resolvedArgs.slice(1), store, process.env));
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

  if (args[0] === "operator") {
    if (args.length > 1) {
      throw usageError("Operator usage: taskmux operator");
    }

    requireStorageSchema(rootDir);
    const store = new FileTaskStore(rootDir);
    const role = store.getGlobalRole(SYSTEM_OPERATOR_ROLE);
    if (role === null) {
      throw dataError("Operator role is not configured. Run taskmux setup.");
    }
    const prepared = prepareGlobalRoleLaunch(role, { taskmuxHome: rootDir, baseEnv: process.env });
    const tmux = new TmuxManager(process.env.TASKMUX_TMUX_BIN ?? "tmux", new NodeCommandExecutor());
    const taskRole: Role = { ...role, status: "idle" };
    tmux.enterRole("operator", taskRole, {
      command: role.command,
      args: prepared.args,
      env: operatorLaunchEnvironment(role.env, prepared.env)
    });
    emit("Detached Operator session");
    return;
  }

  if (args[0] === "agent") {
    requireStorageSchema(rootDir);
    const discovery = process.env.TASKMUX_CONTROLLER_MODE === "direct"
      ? undefined
      : await ensureControllerRunning(rootDir, process.env);
    const store = new FileTaskStore(rootDir);
    const resolvedArgs = await resolveTerminalArguments(args, invocation.node, store);
    if (resolvedArgs === null) {
      emit("Cancelled.");
      return;
    }
    if (discovery !== undefined) {
      await printControllerCommand(rootDir, "agent", resolvedArgs.slice(1), discovery);
      return;
    }
    emit(runAgentCommand(resolvedArgs.slice(1), store));
    return;
  }

  if (args[0] === "role") {
    requireStorageSchema(rootDir);
    const discovery = args[1] !== "enter" && process.env.TASKMUX_CONTROLLER_MODE !== "direct"
      ? await ensureControllerRunning(rootDir, process.env)
      : undefined;
    const store = new FileTaskStore(rootDir);
    const resolvedArgs = await resolveTerminalArguments(args, invocation.node, store);
    if (resolvedArgs === null) {
      emit("Cancelled.");
      return;
    }
    if (discovery !== undefined) {
      await printControllerCommand(rootDir, "role", resolvedArgs.slice(1), discovery);
      return;
    }
    emit(runGlobalRoleCommand(resolvedArgs.slice(1), store, { taskmuxHome: rootDir }));
    return;
  }

  if (args[0] === "task") {
    requireStorageSchema(rootDir);
    const discovery = process.env.TASKMUX_CONTROLLER_MODE === "direct"
      ? undefined
      : await ensureControllerRunning(rootDir, process.env);
    const store = new FileTaskStore(rootDir);
    const tmux = new TmuxManager(process.env.TASKMUX_TMUX_BIN ?? "tmux", new NodeCommandExecutor());
    const scopedTaskArgs = resolveTaskCommandScope(args.slice(1), process.env);
    const resolvedFullArgs = await resolveTerminalArguments(["task", ...scopedTaskArgs], invocation.node, store);
    if (resolvedFullArgs === null) {
      emit("Cancelled.");
      return;
    }
    const taskArgs = resolvedFullArgs.slice(1);

    if (taskArgs[0] === "shell") {
      const taskId = taskArgs[1];

      if (taskId === undefined || taskId.trim().length === 0) {
        throw usageError("Task id is required.");
      }

      const resolveShellArguments = async (
        commandArgs: string[],
        shellIo: import("./shell/taskShell.js").TaskShellSelectionIo
      ): Promise<string[] | null> => {
        const shellInvocation = routeInvocation(["task", ...commandArgs]);
        if (shellInvocation.kind !== "execute") {
          return commandArgs;
        }
        const result = await resolveInteractiveArguments(["task", ...commandArgs], shellInvocation.node, store, {
          interactive: shellIo.interactive,
          json: false,
          width: shellIo.width,
          write: shellIo.write,
          question: shellIo.question
        }, { preferredRole: process.env.TASKMUX_ROLE?.trim() });
        return result.kind === "cancelled" ? null : result.args.slice(1);
      };

      if (discovery === undefined) {
        await runTaskShell(taskId, store, tmux, undefined, resolveShellArguments);
        return;
      }
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
      }, resolveShellArguments);
      return;
    }

    if (taskArgs[0] === "enter" && discovery !== undefined) {
      emit(await attachTaskRoleThroughController(taskArgs, store, tmux, discovery));
      return;
    }

    if (taskArgs[0] !== "enter" && discovery !== undefined) {
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

  throw usageError(`Unknown command: ${args[0]}`);
}

async function resolveTerminalArguments(
  commandArgs: readonly string[],
  node: import("./cli/commandCatalog.js").CommandNode,
  store: FileTaskStore
): Promise<string[] | null> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!interactive || !allowsInteractiveSelection(commandArgs, jsonOutput)) {
    return [...commandArgs];
  }

  const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    const result = await resolveInteractiveArguments(commandArgs, node, store, {
      interactive,
      json: jsonOutput,
      width: process.stdout.columns ?? 100,
      write: (value) => process.stdout.write(value),
      question: async (prompt) => {
        try {
          return await readline.question(prompt);
        } catch (error) {
          if (
            error instanceof Error &&
            (error.name === "AbortError" || "code" in error && error.code === "ERR_USE_AFTER_CLOSE")
          ) {
            return undefined;
          }
          throw error;
        }
      }
    }, { preferredRole: process.env.TASKMUX_ROLE?.trim() });
    return result.kind === "cancelled" ? null : result.args;
  } finally {
    readline.close();
  }
}

function resolveCliIdentity(env: NodeJS.ProcessEnv): CliIdentity {
  return env.TASKMUX_CLI_NAME === "taskmux-dev" ? "taskmux-dev" : "taskmux";
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
  if (command === "transcript" && rest[0] === "export") {
    if (!hasTaskId(rest[1])) {
      const transcriptArgs = rest.slice(1);
      const hasExplicitRole = transcriptArgs[0] !== undefined && !transcriptArgs[0].startsWith("--");
      return [
        command,
        "export",
        taskId,
        ...(hasExplicitRole || roleName === undefined || roleName.length === 0 ? [] : [roleName]),
        ...transcriptArgs
      ];
    }
    return commandArgs;
  }
  if (["detail", "tail", "status", "transcript"].includes(command) && !hasTaskId(rest[0])) {
    return [
      command,
      taskId,
      ...(rest.length > 0
        ? rest
        : roleName === undefined || roleName.length === 0 ? [] : [roleName])
    ];
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

async function printControllerCommand(
  rootDir: string,
  group: string,
  commandArgs: string[],
  existingDiscovery?: Awaited<ReturnType<typeof ensureControllerRunning>>
): Promise<void> {
  const discovery = existingDiscovery ?? await ensureControllerRunning(rootDir, process.env);
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
    "TASKMUX_OPERATOR_CONTEXT"
  ]) {
    const value = preparedEnvironment[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

async function runDefaultDashboard(rootDir: string): Promise<void> {
  const commandExecutor = new NodeCommandExecutor();
  const storageSchema = inspectStorageSchema(rootDir);
  const storeForDoctor = new FileTaskStore(rootDir);
  const agents = canReadStore(storageSchema) ? listConfiguredAgentsForDoctor(storeForDoctor) : [];
  const checks = getDoctorChecks(process.env, commandExecutor, agents, storageSchema);
  const failedChecks = checks.filter((check) => check.status !== "ok");

  process.stdout.write(renderDoctor(checks));

  if (failedChecks.length > 0) {
    throw dataError(`Doctor checks failed: ${failedChecks.map((check) => `${check.name}=${check.status}`).join(", ")}`);
  }

  requireStorageSchema(rootDir);
  const store = new FileTaskStore(rootDir);
  const tmux = new TmuxManager(process.env.TASKMUX_TMUX_BIN ?? "tmux", commandExecutor);

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

function listConfiguredAgentsForDoctor(store: FileTaskStore) {
  try {
    return store.listConfiguredAgents();
  } catch {
    return [];
  }
}
