#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import { renderCommandHelp } from "./cli/helpRenderer.js";
import { routeInvocation } from "./cli/invocationRouter.js";
import { renderCompletion, type CliIdentity } from "./cli/completion.js";
import { resolveCompletionCandidates } from "./cli/dynamicCompletion.js";
import {
  allowsInteractiveSelection,
  resolveInteractiveArguments,
  type SelectionIo
} from "./cli/interactiveSelection.js";
import { runCompletionWizard } from "./cli/completionWizard.js";
import type { SelectionPorts } from "./cli/selectionPorts.js";
import { runUpdateCommand } from "./cli/updateCommand.js";
import {
  runAgentCommand,
  type AgentCommandStore
} from "./commands/agentCommands.js";
import {
  runGlobalRoleCommand,
  type GlobalRoleCommandOptions
} from "./commands/globalRoleCommands.js";
import { runJobCommand } from "./commands/jobCommands.js";
import { runOperatorCommand } from "./commands/operatorCommands.js";
import { runRepositoryCommand } from "./commands/repositoryCommands.js";
import { runTaskCommand } from "./commands/taskCommands.js";
import { FileCompletionManager, resolveCliIdentity } from "./completion/fileCompletionManager.js";
import {
  callFileTaskController,
  ensureFileTaskController,
  FileTaskWorkflowRuntime,
  restartFileTaskController
} from "./controller/clientRuntime.js";
import { FileSchedulerStoreAdapter } from "./controller/fileSchedulerStoreAdapter.js";
import { runSessionNotifyCommand } from "./controller/sessionNotify.js";
import { runDoctorCommand } from "./doctor/doctor.js";
import { CliError, usageError } from "./errors/cliError.js";
import { FileRoleLaunchPlanner } from "./executor/fileRoleLaunchPlanner.js";
import { FileTaskWorkspacePreparer } from "./repository/taskWorkspacePreparer.js";
import { inspectStorageSchema, requireStorageSchema } from "./storage/storageSchema.js";
import { FileTaskStore, resolveTaskmuxHome } from "./storage/taskStore.js";
import { runSetupCommand, validateSetupInvocation } from "./setup/setupCommand.js";
import { NodeCommandExecutor } from "./tmux/commandExecutor.js";
import { TmuxManager } from "./tmux/tmuxManager.js";

const VERSION = readPackageVersion();
const rawArgs = process.argv.slice(2);
const jsonOutput = rawArgs.includes("--json");
const args = normalizeAliases(
  jsonOutput ? rawArgs.filter((argument) => argument !== "--json") : rawArgs
);

void main().catch((error: unknown) => {
  if (error instanceof CliError) {
    const rendered = jsonOutput
      ? JSON.stringify({ ok: false, code: error.code, message: error.message, details: {} })
      : `${error.code}: ${error.message}${error.helpText === undefined ? "" : `\n\n${error.helpText.trimEnd()}`}`;
    process.stderr.write(`${rendered}\n`);
    process.exitCode = error.exitCode;
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${jsonOutput
    ? JSON.stringify({ ok: false, code: "RUNTIME_ERROR", message, details: {} })
    : `RUNTIME_ERROR: ${message}`}\n`);
  process.exitCode = 5;
});

export async function main(): Promise<void> {
  if (args.length === 0) {
    emit(renderCommandHelp((await import("./cli/commandCatalog.js")).ROOT_COMMAND, VERSION));
    return;
  }
  if (args[0] === "version" && args.length === 1) {
    emit(VERSION, true);
    return;
  }

  const invocation = routeInvocation(args);
  if (invocation.kind === "help") {
    emit(renderCommandHelp(invocation.node, VERSION), true);
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
      renderCommandHelp(invocation.helpNode, VERSION)
    );
  }

  if (args[0] === "version") throw usageError("Version usage: taskmux version");
  if (args[0] === "update") {
    if (jsonOutput) throw usageError("Update does not support --json.");
    if (args.length !== 1) throw usageError("Update usage: taskmux update");
    process.exitCode = runUpdateCommand();
    return;
  }

  const home = resolveTaskmuxHome(process.env);
  if (args[0] === "completion") {
    await completionCommand(home, invocation.node);
    return;
  }

  if (args[0] === "setup") {
    if (jsonOutput) throw usageError("Setup does not support --json.");
    const setupIo = {
      input: process.stdin,
      output: process.stdout,
      forceInteractive: process.env.TASKMUX_SETUP_INTERACTIVE === "1"
    };
    validateSetupInvocation(args.slice(1), setupIo);
    emit(await runSetupCommand(
      args.slice(1),
      process.env,
      new NodeCommandExecutor(),
      setupIo
    ));
    return;
  }
  if (args[0] === "doctor") {
    emit(runDoctorCommand(args.slice(1), process.env, new NodeCommandExecutor()));
    return;
  }
  if (args[0] === "internal") {
    if (args[1] !== "session-notify" || args.length !== 3) {
      throw usageError("Internal session notify usage is invalid.");
    }
    await runSessionNotifyCommand(args[2], process.env);
    return;
  }

  requireStorageSchema(home);
  const store = new FileTaskStore(home);
  const resolved = await resolveTerminalArguments(args, invocation.node, store);
  if (resolved === null) {
    emit("Cancelled.");
    return;
  }

  if (resolved[0] === "controller") {
    const method = resolved[1];
    if ((method !== "status" && method !== "stop" && method !== "restart") || resolved.length !== 2) {
      throw usageError("Controller usage: taskmux controller status|stop|restart.");
    }
    const controllerMethod: "status" | "stop" | "restart" = method;
    const result = controllerMethod === "restart"
      ? await restartFileTaskController(home, { environment: process.env })
      : await callFileTaskController(home, `controller.${controllerMethod}`);
    emit(renderControllerResult(controllerMethod, result));
    return;
  }

  const executor = new NodeCommandExecutor();
  const tmux = new TmuxManager(
    process.env.TASKMUX_TMUX_BIN ?? "tmux",
    executor,
    { taskmuxHome: home, terminalInput: process.stdin }
  );
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  const planner = new FileRoleLaunchPlanner(home, store, { environment: process.env });
  const workspacePreparer = new FileTaskWorkspacePreparer(home, store);
  const runtime = new FileTaskWorkflowRuntime(
    home,
    store,
    schedulerStore,
    planner,
    tmux,
    workspacePreparer,
    {
      environment: process.env,
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Controller runtime error: ${message}\n`);
      }
    }
  );

  if (resolved[0] === "agent") {
    emit(runAgentCommand(resolved.slice(1), store as unknown as AgentCommandStore));
    return;
  }
  if (resolved[0] === "repository") {
    emit(await runRepositoryCommand(resolved.slice(1), store));
    return;
  }
  if (resolved[0] === "role") {
    const roleOptions: GlobalRoleCommandOptions = {
      taskmuxHome: home,
      env: process.env
    };
    const result = runGlobalRoleCommand(
      resolved.slice(1),
      store as unknown as Parameters<typeof runGlobalRoleCommand>[1],
      roleOptions
    );
    if (typeof result === "string") {
      emit(result);
      return;
    }
    await ensureFileTaskController(home, { environment: process.env });
    runtime.prepareGlobalRoleEnter(result.role.name);
    tmux.attachRole("operator", result.role.name);
    return;
  }
  if (resolved[0] === "operator") {
    if (resolved[1] === "enter") {
      if (resolved.length !== 2) throw usageError("Operator enter usage: taskmux operator enter.");
      await ensureFileTaskController(home, { environment: process.env });
      runtime.prepareGlobalRoleEnter("operator");
      tmux.attachRole("operator", "operator");
      return;
    }
    const result = runOperatorCommand(resolved.slice(1), store, { runtime, environment: process.env });
    if (result.kind !== "output") throw new Error("Operator submit returned an invalid control result.");
    emit(result.output);
    return;
  }
  if (resolved[0] === "task") {
    if (
      (resolved[1] === "enter")
      || (resolved[1] === "role" && resolved[2] === "enter")
    ) {
      await ensureFileTaskController(home, { environment: process.env });
    }
    const result = runTaskCommand(resolved.slice(1), store, { runtime, environment: process.env });
    if (result.kind === "output") {
      emit(result.output);
      return;
    }
    if (result.output !== undefined) emit(result.output);
    tmux.attachRole(result.taskId, result.roleName);
    return;
  }
  if (resolved[0] === "jobs") {
    emit(runJobCommand(resolved.slice(1), store, { runtime }));
    return;
  }

  throw usageError(
    `Command is not connected to the restored FileTaskStore framework yet: ${resolved[0]}.`,
    renderCommandHelp(invocation.node, VERSION)
  );
}

function renderControllerResult(method: "status" | "stop" | "restart", value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const result = value as Record<string, unknown>;
  if (method === "status") {
    if (result.running !== true) return "Controller is not running.";
    return result.pid === undefined
      ? "Controller is running."
      : `Controller is running (PID ${String(result.pid)}).`;
  }
  if (method === "restart") {
    const previousPid = Number.isSafeInteger(result.previousPid) ? String(result.previousPid) : undefined;
    const pid = Number.isSafeInteger(result.pid) ? String(result.pid) : undefined;
    if (previousPid !== undefined && pid !== undefined) {
      return `Controller restarted (PID ${previousPid} -> ${pid}). tmux sessions were not stopped.`;
    }
    return pid === undefined
      ? "Controller restarted. tmux sessions were not stopped."
      : `Controller started (PID ${pid}). tmux sessions were not stopped.`;
  }
  return result.stopped === true
    ? "Controller stopped."
    : "Controller was already stopped.";
}

async function completionCommand(
  home: string,
  node: import("./cli/commandCatalog.js").CommandNode
): Promise<void> {
  if (args[1] === "candidates") {
    const separator = args.indexOf("--");
    const prefix = args[2];
    if (prefix === undefined || separator !== 3) {
      throw usageError("Completion candidates usage: taskmux completion candidates <prefix> -- <words...>");
    }
    const candidates = await resolveCompletionCandidates({
      current: prefix,
      words: args.slice(separator + 1),
      ports: completionSelectionPorts(home)
    });
    process.stdout.write(candidates.length === 0 ? "" : `${candidates.join("\n")}\n`);
    return;
  }

  if (jsonOutput) throw usageError("Completion configuration does not support --json.");
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw usageError("Completion configuration requires an interactive terminal.");
  }
  const shell = completionShell(args[1]);
  if (args.length > (shell === undefined ? 1 : 2)) {
    throw usageError("Completion usage: taskmux completion [bash|zsh|fish]");
  }
  requireStorageSchema(home);
  const store = new FileTaskStore(home);
  const ioHandle = terminalIo();
  try {
    const manager = new FileCompletionManager(store, process.env, resolveCliIdentity(process.env));
    emit(await runCompletionWizard(
      manager,
      ioHandle.io,
      shell === undefined ? {} : { shell }
    ));
  } finally {
    ioHandle.close();
  }
  void node;
}

function completionShell(value: string | undefined): "bash" | "zsh" | "fish" | undefined {
  if (value === undefined) return undefined;
  if (value === "bash" || value === "zsh" || value === "fish") return value;
  throw usageError("Completion shell must be one of bash, zsh, fish.");
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
  const handle = terminalIo();
  try {
    const result = await resolveInteractiveArguments(
      commandArgs,
      node,
      selectionPorts(store),
      handle.io
    );
    return result.kind === "cancelled" ? null : result.args;
  } finally {
    // The Agent process must be the only reader of stdin after Role enter.
    handle.close();
  }
}

function terminalIo(): Readonly<{ io: SelectionIo; close(): void }> {
  const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return {
    io: {
      interactive: true,
      json: jsonOutput,
      width: process.stdout.columns ?? 100,
      write: (value) => { process.stdout.write(value); },
      question: async (prompt) => {
        try {
          return await readline.question(prompt);
        } catch (error) {
          if (error instanceof Error && (
            error.name === "AbortError"
            || ("code" in error && error.code === "ERR_USE_AFTER_CLOSE")
          )) return undefined;
          throw error;
        }
      }
    },
    close: () => { readline.close(); }
  };
}

function selectionPorts(store: FileTaskStore): SelectionPorts {
  return {
    call: (method, params) => selectionCall(store, method, params)
  };
}

function selectionCall(
  store: FileTaskStore,
  method: string,
  params: Readonly<Record<string, unknown>>
): unknown {
  const reader = store as unknown as Record<string, (...args: never[]) => unknown>;
  switch (method) {
    case "agent.list": return store.listConfiguredAgents();
    case "role.list": return store.listGlobalRoles();
    case "repository.list": return callOptional(reader, "listRepositories");
    case "task.list": return callOptional(reader, "listTasks");
    case "task.role.list": return callOptional(reader, "listRoles", [params.taskId]);
    case "task.work.list": return callOptional(reader, "listWorkItems", [params.taskId]);
    case "task.run.list": return callOptional(reader, "listAgentRuns", [params.workItemId]);
    case "jobs.list": return callOptional(reader, "listJobs");
    default: return [];
  }
}

function callOptional(
  reader: Record<string, (...args: never[]) => unknown>,
  method: string,
  args: unknown[] = []
): unknown {
  const operation = reader[method];
  return operation === undefined ? [] : Reflect.apply(operation, reader, args);
}

function readableStore(home: string): FileTaskStore {
  requireStorageSchema(home);
  return new FileTaskStore(home);
}

function completionSelectionPorts(home: string): SelectionPorts {
  if (inspectStorageSchema(home).status === "uninitialized") {
    return { call: () => [] };
  }
  return selectionPorts(readableStore(home));
}

function emit(output: string, literal = false): void {
  const normalized = literal ? output.trimEnd() : output.trimEnd();
  process.stdout.write(`${jsonOutput
    ? JSON.stringify({ ok: true, output: normalized })
    : normalized}\n`);
}

function readPackageVersion(): string {
  try {
    const value = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    if (typeof value.version === "string" && value.version.length > 0) return value.version;
  } catch {
    // Keep help/version available if package metadata is damaged.
  }
  return "0.0.0";
}

export function cliIdentity(env: NodeJS.ProcessEnv): CliIdentity {
  return env.TASKMUX_CLI_NAME === "taskmux-dev" ? "taskmux-dev" : "taskmux";
}

function normalizeAliases(input: readonly string[]): string[] {
  const normalized = [...input];
  if (normalized.length === 1 && (normalized[0] === "-v" || normalized[0] === "--version")) {
    return ["version"];
  }
  const help = normalized.findIndex((argument) => argument === "-h" || argument === "--help");
  return help === normalized.length - 1 ? ["help", ...normalized.slice(0, help)] : normalized;
}

export { renderCompletion };
