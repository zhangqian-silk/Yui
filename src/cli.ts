#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { runAgentCommand } from "./commands/agentCommands.js";
import { runBackupCommand } from "./commands/backupCommands.js";
import { runConfigCommand } from "./commands/configCommands.js";
import { ensureControllerRunning, runControllerCommand } from "./commands/controllerCommands.js";
import { runGitLifecycleMaintenanceCommand } from "./commands/gitLifecycleMaintenanceCommands.js";
import { callController } from "./controller/controller.js";
import { buildControllerCommandProvenance } from "./controller/commandProvenance.js";
import { runGlobalRoleCommand } from "./commands/globalRoleCommands.js";
import {
  executePruneCommand,
  executeRestoreCommand,
  runExportCommand,
  runImportCommand
} from "./commands/maintenanceCommands.js";
import {
  isTaskRoleRuntimeControlCommand,
  prepareTaskLifecycleCommand,
  recordTaskRoleAttached,
  runTaskCommand,
  runTaskLifecycleOperation
} from "./commands/taskCommands.js";
import { runDashboard } from "./dashboard/dashboard.js";
import { getDoctorChecks, renderDoctor, runDoctor } from "./doctor/doctor.js";
import { CliError, dataError, usageError } from "./errors/cliError.js";
import { runSetupCommand, validateSetupInvocation } from "./setup/setupCommand.js";
import { runTaskShell } from "./shell/taskShell.js";
import { FileTaskStore, resolveTaskmuxHome } from "./storage/taskStore.js";
import { executeDomainTransaction } from "./storage/domainTransaction.js";
import {
  inspectStorageSchema,
  requireStorageSchema
} from "./storage/storageSchema.js";
import { NodeCommandExecutor } from "./tmux/commandExecutor.js";
import { TmuxManager } from "./tmux/tmuxManager.js";
import { SYSTEM_OPERATOR_ROLE } from "./role/systemRoles.js";
import { pumpOperatorDeliveries } from "./operator/operatorDeliveryPump.js";
import { runTaskInputPostCommitEffects } from "./input/inputPostCommitEffects.js";
import { launchOperatorWindow } from "./operator/operatorLaunchAuthority.js";
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

  if (
    args[0] === "completion" &&
    (args[1] === "bash" || args[1] === "zsh" || args[1] === "fish")
  ) {
    emit(renderCompletion(args[1], resolveCliIdentity(process.env)));
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

    emit(runDoctor(process.env, new NodeCommandExecutor(), storageSchema));
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
    emit(executeDirectDomainCommand(
      rootDir,
      "backup",
      (_transactionStore, workingRoot) => runBackupCommand(workingRoot, rootDir),
      { includeBackups: true }
    ));
    return;
  }

  if (args[0] === "restore") {
    requireStorageSchema(rootDir);
    const restoreArgs = await confirmPhysicalRestore(args.slice(1));
    if (process.env.TASKMUX_CONTROLLER_MODE !== "direct") {
      await printControllerCommand(rootDir, "restore", restoreArgs);
      return;
    }
    emit(executeRestoreCommand(
      rootDir,
      `cli-restore-${randomUUID()}`,
      restoreArgs
    ).output);
    return;
  }

  if (args[0] === "maintenance") {
    requireStorageSchema(rootDir);
    emit(runGitLifecycleMaintenanceCommand(args.slice(1), rootDir));
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
    const commandArgs = resolvedArgs.slice(1);
    emit(
      isDirectConfigSnapshotRead(commandArgs)
        ? runConfigCommand(commandArgs, store, process.env)
        : executeDirectDomainCommand(
          rootDir,
          "config",
          (transactionStore) => runConfigCommand(commandArgs, transactionStore, process.env)
        )
    );
    return;
  }

  if (args[0] === "export") {
    requireStorageSchema(rootDir);
    if (process.env.TASKMUX_CONTROLLER_MODE !== "direct") {
      await printControllerCommand(rootDir, "export", args.slice(1));
      return;
    }
    emit(runExportCommand(args.slice(1), new FileTaskStore(rootDir)));
    return;
  }

  if (args[0] === "import") {
    requireStorageSchema(rootDir);
    if (process.env.TASKMUX_CONTROLLER_MODE !== "direct") {
      await printControllerCommand(rootDir, "import", args.slice(1));
      return;
    }
    emit(executeDirectDomainCommand(
      rootDir,
      "import",
      (transactionStore) => runImportCommand(args.slice(1), transactionStore)
    ));
    return;
  }

  if (args[0] === "prune") {
    requireStorageSchema(rootDir);
    if (process.env.TASKMUX_CONTROLLER_MODE !== "direct") {
      await printControllerCommand(rootDir, "prune", args.slice(1));
      return;
    }
    emit(executePruneCommand(
      rootDir,
      `cli-prune-${randomUUID()}`,
      args.slice(1)
    ));
    return;
  }

  if (args[0] === "operator") {
    if (args.length > 1) {
      throw usageError("Operator usage: taskmux operator");
    }

    requireStorageSchema(rootDir);
    const discovery = process.env.TASKMUX_CONTROLLER_MODE === "direct"
      ? undefined
      : await ensureControllerRunning(rootDir, process.env);
    const tmux = new TmuxManager(
      process.env.TASKMUX_TMUX_BIN ?? "tmux",
      new NodeCommandExecutor(),
      rootDir
    );
    const launched = launchOperatorWindow(rootDir, tmux, process.env);
    pumpOperatorDeliveries(rootDir, tmux);
    if (discovery !== undefined) {
      await callController(discovery, "scheduler.scan", randomUUID());
    }
    tmux.attachRole("operator", launched.taskRole.name);
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
    const commandArgs = resolvedArgs.slice(1);
    emit(
      isDirectAgentSnapshotRead(commandArgs)
        ? runAgentCommand(commandArgs, store)
        : executeDirectDomainCommand(
          rootDir,
          "agent",
          (transactionStore) => runAgentCommand(commandArgs, transactionStore)
        )
    );
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
    const commandArgs = resolvedArgs.slice(1);
    const tmux = new TmuxManager(
      process.env.TASKMUX_TMUX_BIN ?? "tmux",
      new NodeCommandExecutor(),
      rootDir
    );
    const roleOptions = {
      taskmuxHome: rootDir,
      env: process.env,
      tmux
    };
    const output =
      isCoordinatedGlobalRoleMutation(commandArgs) || isDirectGlobalRoleRead(commandArgs)
        ? runGlobalRoleCommand(commandArgs, store, roleOptions)
        : executeDirectDomainCommand(
          rootDir,
          "role",
          (transactionStore) => runGlobalRoleCommand(commandArgs, transactionStore, roleOptions)
        );
    if (
      commandArgs[0] === "session" &&
      commandArgs[1] === "record" &&
      commandArgs[2] === SYSTEM_OPERATOR_ROLE
    ) {
      pumpOperatorDeliveries(rootDir, tmux);
    }
    emit(output);
    return;
  }

  if (args[0] === "task") {
    requireStorageSchema(rootDir);
    const discovery = process.env.TASKMUX_CONTROLLER_MODE === "direct"
      ? undefined
      : await ensureControllerRunning(rootDir, process.env);
    const store = new FileTaskStore(rootDir);
    const tmux = new TmuxManager(
      process.env.TASKMUX_TMUX_BIN ?? "tmux",
      new NodeCommandExecutor(),
      rootDir
    );
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
          json: jsonOutput,
          width: shellIo.width,
          write: shellIo.write,
          question: shellIo.question
        }, { preferredRole: process.env.TASKMUX_ROLE?.trim() });
        return result.kind === "cancelled" ? null : result.args.slice(1);
      };

      if (discovery === undefined) {
        await runTaskShell(
          taskId,
          store,
          tmux,
          async (commandArgs) => runDirectTaskCommand(rootDir, commandArgs, tmux),
          resolveShellArguments
        );
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
          {
            args: commandArgs,
            provenance: buildControllerCommandProvenance("task", commandArgs, store, process.env)
          }
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
        {
          args: taskArgs,
          provenance: buildControllerCommandProvenance("task", taskArgs, store, process.env)
        }
      ) as { output: string };
      if (result.output.length > 0) {
        emit(result.output);
      }
      return;
    }

    emit(runDirectTaskCommand(rootDir, taskArgs, tmux));
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

async function confirmPhysicalRestore(commandArgs: string[]): Promise<string[]> {
  if (commandArgs.includes("--force") || commandArgs[0] === undefined ||
      commandArgs[0].startsWith("--")) {
    return commandArgs;
  }
  if (jsonOutput || (process.stdin.isTTY !== true &&
      process.env.TASKMUX_MAINTENANCE_INTERACTIVE !== "1")) {
    throw usageError("Physical restore requires interactive confirmation or --force.");
  }

  const backupId = commandArgs[0];
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true
  });
  try {
    const answer = await readline.question(`Type ${backupId} to restore this backup: `);
    if (answer.trim() !== backupId) {
      throw usageError("Physical restore confirmation did not match the backup id.");
    }
  } finally {
    readline.close();
  }
  return [...commandArgs, "--force"];
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

function executeDirectDomainCommand<T>(
  rootDir: string,
  label: string,
  execute: (store: FileTaskStore, workingRoot: string) => T,
  options: { includeBackups?: boolean } = {}
): T {
  return executeDomainTransaction(
    rootDir,
    `cli-${label}-${randomUUID()}`,
    (workingRoot) => execute(new FileTaskStore(workingRoot), workingRoot),
    () => [],
    options
  );
}

function runDirectTaskCommand(
  rootDir: string,
  commandArgs: string[],
  tmux: TmuxManager
): string {
  if (isDirectTaskSnapshotRead(commandArgs)) {
    return runTaskCommand(commandArgs, new FileTaskStore(rootDir), tmux);
  }
  const store = new FileTaskStore(rootDir);
  const lifecycle = prepareTaskLifecycleCommand(commandArgs, store);
  if (lifecycle !== null) {
    return runTaskLifecycleOperation(lifecycle, store, tmux);
  }
  if (isTaskRoleRuntimeControlCommand(commandArgs)) {
    return runTaskCommand(commandArgs, store, tmux);
  }
  if (commandArgs[0] === "dispatch") {
    return runTaskCommand(commandArgs, store, tmux);
  }
  if (commandArgs[0] === "enter") {
    const output = runTaskCommand(
      commandArgs,
      store,
      tmux,
      { persistAttachStatus: false }
    );
    const [taskId, roleName] = commandArgs.slice(1);
    if (taskId !== undefined && roleName !== undefined) {
      executeDirectDomainCommand(
        rootDir,
        "task-attach-complete",
        (transactionStore) => recordTaskRoleAttached(taskId, roleName, transactionStore)
      );
    }
    return output;
  }
  const output = executeDirectDomainCommand(
    rootDir,
    "task",
    (transactionStore) => runTaskCommand(commandArgs, transactionStore, tmux)
  );
  runTaskInputPostCommitEffects(rootDir, commandArgs, tmux);
  return output;
}

function isDirectConfigSnapshotRead(args: readonly string[]): boolean {
  return args[0] === "show";
}

function isDirectAgentSnapshotRead(args: readonly string[]): boolean {
  return ["list", "show"].includes(args[0] ?? "");
}

function isDirectGlobalRoleRead(args: readonly string[]): boolean {
  return ["list", "show", "enter"].includes(args[0] ?? "");
}

function isCoordinatedGlobalRoleMutation(args: readonly string[]): boolean {
  return args[0] === "update" || args[0] === "remove";
}

function isDirectTaskSnapshotRead(args: readonly string[]): boolean {
  const command = args[0] ?? "";
  if ([
    "list", "board", "last", "roles", "comments", "events",
    "activity", "timeline", "tail", "detail"
  ].includes(command)) {
    return true;
  }
  if (command === "current") {
    return args.length === 1;
  }
  if (command === "topic" && args[1] === "list") {
    return true;
  }
  if (command === "input" && ["list", "show"].includes(args[1] ?? "")) {
    return true;
  }
  return command === "transcript" && args[1] === "export";
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

  if (command === "input" && ["show", "answer"].includes(rest[0] ?? "")) {
    if (!rest.includes("--task")) {
      return [command, ...rest, "--task", taskId];
    }
    return commandArgs;
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
  const provenance = buildControllerCommandProvenance(
    group,
    commandArgs,
    new FileTaskStore(rootDir),
    process.env
  );
  const result = await callController(
    discovery,
    "command.execute",
    randomUUID(),
    {
      group,
      args: commandArgs,
      ...(provenance === undefined ? {} : { provenance })
    }
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
  const checks = getDoctorChecks(process.env, commandExecutor, storageSchema);
  const failedChecks = checks.filter((check) => check.status !== "ok");

  process.stdout.write(renderDoctor(checks));

  if (failedChecks.length > 0) {
    throw dataError(`Doctor checks failed: ${failedChecks.map((check) => `${check.name}=${check.status}`).join(", ")}`);
  }

  requireStorageSchema(rootDir);
  const store = new FileTaskStore(rootDir);
  const tmux = new TmuxManager(process.env.TASKMUX_TMUX_BIN ?? "tmux", commandExecutor, rootDir);

  if (process.env.TASKMUX_CONTROLLER_MODE === "direct") {
    await runDashboard(
      store,
      tmux,
      async (commandArgs) => runDirectTaskCommand(rootDir, commandArgs, tmux)
    );
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
      {
        args: commandArgs,
        provenance: buildControllerCommandProvenance("task", commandArgs, store, process.env)
      }
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
