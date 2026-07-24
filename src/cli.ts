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
import { resolveRoleWizardArguments } from "./cli/roleWizard.js";
import type { SelectionPorts } from "./cli/selectionPorts.js";
import { runUpdateCommand } from "./cli/updateCommand.js";
import { formatTimestamp } from "./output/timePresentation.js";
import type { ConfiguredAgent } from "./agent/agent.js";
import { nativeAgentEnvironmentNames } from "./agent/launchEnvironment.js";
import {
  runAgentCommand,
  type AgentCommandStore
} from "./commands/agentCommands.js";
import {
  runGlobalRoleCommand,
  type GlobalRoleCommandOptions
} from "./commands/globalRoleCommands.js";
import { runConfigCommand } from "./commands/configCommands.js";
import { runJobCommand } from "./commands/jobCommands.js";
import { runOperatorCommand } from "./commands/operatorCommands.js";
import { runRepositoryCommand } from "./commands/repositoryCommands.js";
import { runTaskCommand } from "./commands/taskCommands.js";
import { FileCompletionManager, resolveCliIdentity } from "./completion/fileCompletionManager.js";
import {
  callFileTaskController,
  ensureFileTaskController,
  FileTaskWorkflowRuntime,
  refreshRunningFileTaskControllerConfiguration,
  refreshRunningFileTaskControllerEnvironment,
  type RunningControllerRefreshResult,
  restartFileTaskController
} from "./controller/clientRuntime.js";
import { FileSchedulerStoreAdapter } from "./controller/fileSchedulerStoreAdapter.js";
import { runSessionNotifyCommand } from "./controller/sessionNotify.js";
import { runDoctorCommand } from "./doctor/doctor.js";
import { CliError, usageError } from "./errors/cliError.js";
import { FileRoleLaunchPlanner } from "./executor/fileRoleLaunchPlanner.js";
import { FileTaskWorkspacePreparer } from "./repository/taskWorkspacePreparer.js";
import { inspectStorageSchema, requireStorageSchema } from "./storage/storageSchema.js";
import { FileTaskStore, resolveYuiHome } from "./storage/taskStore.js";
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

  if (args[0] === "version") throw usageError("Version usage: yui version");
  if (args[0] === "update") {
    if (jsonOutput) throw usageError("Update does not support --json.");
    if (args.length !== 1) throw usageError("Update usage: yui update");
    process.exitCode = runUpdateCommand();
    return;
  }

  const home = resolveYuiHome(process.env);
  if (args[0] === "completion") {
    await completionCommand(home, invocation.node);
    return;
  }

  if (args[0] === "setup") {
    if (jsonOutput) throw usageError("Setup does not support --json.");
    const setupIo = {
      input: process.stdin,
      output: process.stdout,
      forceInteractive: process.env.YUI_SETUP_INTERACTIVE === "1"
    };
    validateSetupInvocation(args.slice(1), setupIo);
    const output = await runSetupCommand(
      args.slice(1),
      process.env,
      new NodeCommandExecutor(),
      setupIo
    );
    const refresh = await refreshRunningFileTaskControllerEnvironment(
      home,
      new FileTaskStore(home),
      process.env
    );
    emit(withControllerRefreshWarning(output, refresh, "Agent environment"));
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
      throw usageError("Controller usage: yui controller status|stop|restart.");
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
    process.env.YUI_TMUX_BIN ?? "tmux",
    executor,
    { yuiHome: home, terminalInput: process.stdin }
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
    const agentArgs = resolved.slice(1);
    const affectedAgentId = agentArgs[1];
    const previousAgent = typeof affectedAgentId === "string"
      ? store.getConfiguredAgent(affectedAgentId)
      : null;
    const output = runAgentCommand(
      agentArgs,
      store as unknown as AgentCommandStore
    );
    if (
      agentArgs[0] === "add"
      || agentArgs[0] === "update"
      || agentArgs[0] === "remove"
    ) {
      const currentAgent = typeof affectedAgentId === "string"
        ? store.getConfiguredAgent(affectedAgentId)
        : null;
      const scope = agentEnvironmentRefreshScope(
        previousAgent,
        currentAgent,
        store.listConfiguredAgents()
      );
      const refresh = await refreshRunningFileTaskControllerEnvironment(
        home,
        store,
        process.env,
        scope
      );
      emit(withControllerRefreshWarning(output, refresh, "Agent environment"));
      return;
    }
    emit(output);
    return;
  }
  if (resolved[0] === "config") {
    const configArgs = resolved.slice(1);
    const output = runConfigCommand(configArgs, store);
    if (
      configArgs[0] === "set"
      && configArgs[1] === "--reconciliation-interval-seconds"
    ) {
      const refresh = await refreshRunningFileTaskControllerConfiguration(
        home,
        { environment: process.env }
      );
      emit(withControllerRefreshWarning(output, refresh, "Controller configuration"));
      return;
    }
    emit(output);
    return;
  }
  if (resolved[0] === "repository") {
    emit(await runRepositoryCommand(resolved.slice(1), store));
    return;
  }
  if (resolved[0] === "role") {
    const roleOptions: GlobalRoleCommandOptions = {
      yuiHome: home,
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
    await runtime.prepareGlobalRoleEnter(result.role.name);
    tmux.attachRole("operator", result.role.name);
    return;
  }
  if (resolved[0] === "operator") {
    if (resolved[1] === "enter") {
      if (resolved.length !== 2) throw usageError("Operator enter usage: yui operator enter.");
      await ensureFileTaskController(home, { environment: process.env });
      await runtime.prepareGlobalRoleEnter("operator");
      tmux.attachRole("operator", "operator");
      return;
    }
    const result = runOperatorCommand(resolved.slice(1), store, { runtime, environment: process.env });
    if (result.kind !== "output") throw new Error("Operator submit returned an invalid control result.");
    emit(result.output);
    return;
  }
  if (resolved[0] === "task") {
    const enteringTask =
      (resolved[1] === "enter")
      || (resolved[1] === "role" && resolved[2] === "enter");
    if (enteringTask) {
      await ensureFileTaskController(home, { environment: process.env });
      const taskId = resolved[1] === "enter" ? resolved[2] : resolved[3];
      const task = taskId === undefined ? null : store.getTask(taskId);
      if (task?.status === "active" && task.repositoryId !== undefined) {
        await workspacePreparer.prepareTaskWorkspace(task.id);
      }
    }
    const result = runTaskCommand(
      resolved.slice(1),
      store,
      { runtime, environment: process.env, yuiHome: home }
    );
    if (result.kind === "output") {
      emit(result.output, false, result.data);
      return;
    }
    await runtime.prepareTaskRoleEnter({
      taskId: result.taskId,
      roleName: result.roleName
    });
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
      throw usageError("Completion candidates usage: yui completion candidates <prefix> -- <words...>");
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
    throw usageError("Completion usage: yui completion [bash|zsh|fish]");
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
    const ports = selectionPorts(store);
    // Global Role add owns its Agent choice so the configured default can be
    // shown explicitly. Other commands first resolve missing positional
    // targets through the generic selector, then enter the focused Role UI.
    if (
      (commandArgs[0] === "role" && commandArgs[1] === "add")
      || (commandArgs[0] === "task" && commandArgs[1] === "role" && commandArgs[2] === "add")
    ) {
      const wizard = await resolveRoleWizardArguments(commandArgs, ports, handle.io);
      if (wizard.kind === "cancelled") return null;
      const selected = await resolveInteractiveArguments(wizard.args, node, ports, handle.io);
      return selected.kind === "cancelled" ? null : selected.args;
    }
    const selected = await resolveInteractiveArguments(commandArgs, node, ports, handle.io);
    if (selected.kind === "cancelled") return null;
    const wizard = await resolveRoleWizardArguments(selected.args, ports, handle.io);
    return wizard.kind === "cancelled" ? null : wizard.args;
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
    case "config.get": return store.getConfig();
    case "role.list": return store.listGlobalRoles();
    case "role.show": return store.getGlobalRole(String(params.name ?? ""));
    case "repository.list": return callOptional(reader, "listRepositories");
    case "task.list": return callOptional(reader, "listTasks");
    case "task.role.list": return callOptional(reader, "listRoles", [params.taskId]);
    case "task.role.show": return callOptional(reader, "getRole", [params.taskId, params.roleName]);
    case "task.work.list": return callOptional(reader, "listWorkItems", [params.taskId]);
    case "task.input.list": {
      const taskId = typeof params.taskId === "string" ? params.taskId : undefined;
      const requests = taskId === undefined
        ? store.listAllInputRequests()
        : store.listInputRequests(taskId);
      return params.all === true ? requests : requests.filter((request) => request.status === "open");
    }
    case "task.run.list": return callOptional(reader, "listAgentRuns", [params.workItemId]);
    case "task.decision.list": return callOptional(reader, "listDecisions", [params.taskId]);
    case "task.milestone.list": return presentSelectionTimes(
      callOptional(reader, "listMilestones", [params.taskId]),
      store
    );
    case "task.event.list": return presentSelectionTimes(
      callOptional(reader, "listEvents", [params.taskId]),
      store
    );
    case "jobs.list": return callOptional(reader, "listJobs");
    default: return [];
  }
}

function presentSelectionTimes(value: unknown, store: FileTaskStore): unknown {
  if (!Array.isArray(value)) return value;
  const timeZone = store.getConfig().timeZone;
  return value.map((record) => {
    if (typeof record !== "object" || record === null || Array.isArray(record)) return record;
    const candidate = record as Record<string, unknown>;
    return typeof candidate.createdAt === "string"
      ? {
          ...candidate,
          createdAt: formatTimestamp(candidate.createdAt, timeZone)
        }
      : candidate;
  });
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

function emit(output: string, literal = false, data?: unknown): void {
  const normalized = literal ? output.trimEnd() : output.trimEnd();
  process.stdout.write(`${jsonOutput
    ? JSON.stringify(data === undefined
        ? { ok: true, output: normalized }
        : { ok: true, data })
    : normalized}\n`);
}

function withControllerRefreshWarning(
  output: string,
  refresh: RunningControllerRefreshResult,
  label: string
): string {
  if (refresh.status !== "failed") return output;
  if (label === "Agent environment") {
    return `${output.trimEnd()}\nWarning: Agent configuration was saved, but its current `
      + `environment values were not applied or persisted (${refresh.message}). Retry the `
      + "Agent command with those variables present, or restart the Controller from an "
      + "environment that provides them.\n";
  }
  return `${output.trimEnd()}\nWarning: ${label} was saved, but the running Controller `
    + `could not be refreshed (${refresh.message}). Restart the Controller to apply it.\n`;
}

function agentEnvironmentRefreshScope(
  previous: ConfiguredAgent | null,
  current: ConfiguredAgent | null,
  configured: readonly ConfiguredAgent[]
): Readonly<{ sourceNames: readonly string[]; nativeNames: readonly string[] }> {
  const retainedSources = new Set(configured.flatMap((agent) => (
    agent.environment.map((binding) => binding.sourceName)
  )));
  const retainedNative = new Set(configured.flatMap((agent) => (
    nativeAgentEnvironmentNames(agent.adapterId)
  )));
  const currentSources = current?.environment.map((binding) => binding.sourceName) ?? [];
  const previousOnlySources = previous?.environment
    .map((binding) => binding.sourceName)
    .filter((name) => !retainedSources.has(name)) ?? [];
  const currentNative = current === null ? [] : nativeAgentEnvironmentNames(current.adapterId);
  const previousOnlyNative = previous === null
    ? []
    : nativeAgentEnvironmentNames(previous.adapterId).filter((name) => !retainedNative.has(name));
  return {
    sourceNames: [...new Set([...currentSources, ...previousOnlySources])],
    nativeNames: [...new Set([...currentNative, ...previousOnlyNative])]
  };
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
  return env.YUI_CLI_NAME === "yui-dev" ? "yui-dev" : "yui";
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
