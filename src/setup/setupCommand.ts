import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { dataError, usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { presentAgentDefinition } from "../output/roleAgentPresentation.js";
import {
  createGlobalRole,
  createRoleAgentBinding,
  switchActiveRoleAgent,
  updateGlobalRole
} from "../role/role.js";
import { SYSTEM_LEADER_ROLE, SYSTEM_OPERATOR_ROLE } from "../role/systemRoles.js";
import { configuredAgentToDefinition, createConfiguredAgent } from "../agent/agent.js";
import type { AgentDefinition, ConfiguredAgent } from "../agent/agent.js";
import { resolveAgent } from "../agent/agentRegistry.js";
import { enrollAgentCapabilityProbePin, findAgentAdapter } from "../executor/agentAdapter.js";
import { createRoleSessionSet } from "../executor/agentExecutor.js";
import {
  ensureTaskmuxHome,
  FileTaskStore,
  inspectTaskmuxHome,
  resolveTaskmuxHome,
  type TaskStore
} from "../storage/taskStore.js";
import {
  executeDomainTransaction,
  hasActiveDomainTransactionAuthority
} from "../storage/domainTransaction.js";
import { ensureStorageSchema } from "../storage/storageSchema.js";
import type { CommandExecutor } from "../tmux/commandExecutor.js";
import { TmuxManager } from "../tmux/tmuxManager.js";
import { runCompletionWizard } from "../completion/completionWizard.js";
import type { CliIdentity } from "../cli/completion.js";

export type SetupDependency = "tmux";

type SetupOptions = {
  dependency?: SetupDependency;
};

type InstallStep = {
  command: string;
  args: string[];
};

type InstallPlan = {
  manager: string;
  steps: InstallStep[];
  manualHint: string;
};

export type SetupIo = {
  input?: Readable & { isTTY?: boolean };
  output?: Writable & { columns?: number };
  forceInteractive?: boolean;
};

type InteractiveSetupIo = Required<Pick<SetupIo, "input" | "output">> & SetupIo;

type SetupAgentChoice = {
  name: string;
  adapterId: "codex" | "claude";
  description: string;
};

type SetupAgentOption = {
  name: string;
  adapterId: string;
  command: string;
  executable: string;
  description: string;
  index: number;
  status: "installed" | "missing" | "unsupported version" | "probe failed" | "live probe unavailable" | "unsafe probe output" | "refresh required";
  selectable: boolean;
  current: boolean;
};

type SetupConfigResult = {
  configuredAgent: ConfiguredAgent;
  defaultAgent: AgentDefinition | null;
  defaultWorkspace: string | undefined;
};

type SetupRoleRuntime = {
  activeRun: boolean;
  nativeProcessRunning: boolean;
};

type SetupRoleRuntimeProbe = (roleName: string) => SetupRoleRuntime;

type SetupTmuxProbe = Pick<TmuxManager, "probeRoleStatus">;

type SetupQuestion = (prompt: string) => Promise<string>;

const setupAgentChoices: SetupAgentChoice[] = [
  { name: "codex", adapterId: "codex", description: "OpenAI Codex CLI" },
  { name: "claude", adapterId: "claude", description: "Anthropic Claude Code" }
];

export async function runSetupCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  executor: CommandExecutor,
  io: SetupIo = {}
): Promise<string> {
  const options = parseSetupOptions(args);
  const dependencies: SetupDependency[] = options.dependency === undefined ? ["tmux"] : [options.dependency];
  const outputLines: string[] = [];

  if (!shouldPrompt(io)) {
    throw setupRequiresInteractiveError();
  }

  const readline = createInterface({
    input: io.input,
    output: io.output,
    terminal: io.input?.isTTY === true
  });

  try {
    const question = createSetupQuestion(readline, io);
    const taskmuxHome = resolveTaskmuxHome(env);

    await ensureSetupTaskmuxHome(taskmuxHome, question, io.input.isTTY === true);
    ensureStorageSchema(taskmuxHome);

    const store = new FileTaskStore(taskmuxHome);
    const configResult = await promptForRequiredConfig(store, taskmuxHome, env, io, question);
    const completionResult = await runCompletionWizard(
      "install",
      store,
      env,
      setupCliIdentity(env),
      question,
      { width: tableWidth(io), defaultSelection: "skip" }
    );

    if (configResult.defaultAgent !== null && configResult.defaultWorkspace !== undefined) {
      commitSetupSystemState(
        store,
        configResult.configuredAgent,
        configResult.defaultWorkspace,
        new TmuxManager(env.TASKMUX_TMUX_BIN ?? "tmux", executor, taskmuxHome)
      );
    }
    outputLines.push("TaskMux home initialized.");
    outputLines.push("Workspace initialized under TaskMux home.");
    outputLines.push(completionResult.trimEnd());

    for (const dependency of dependencies) {
      if (dependency === "tmux") {
        outputLines.push(...await setupTmux(env, executor, question));
      }
    }

    outputLines.push("TaskMux setup complete.");

    return `${outputLines.join("\n")}\n`;
  } finally {
    readline.close();
  }
}

async function ensureSetupTaskmuxHome(
  taskmuxHome: string,
  question: SetupQuestion,
  permissionRepairHasRealTty: boolean
): Promise<void> {
  const inspection = inspectTaskmuxHome(taskmuxHome);
  if (inspection.status !== "repair-required") {
    ensureTaskmuxHome(taskmuxHome);
    return;
  }

  if (!permissionRepairHasRealTty) {
    throw dataError(
      "Repairing an existing TASKMUX_HOME requires a real interactive terminal. Re-run taskmux setup in a TTY. No files or permissions were changed."
    );
  }

  const answer = (await question(
    `TASKMUX_HOME ${taskmuxHome} has mode ${inspection.mode}. Tighten existing TASKMUX_HOME to mode 0700? [y/N]: `
  )).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    throw dataError(
      "Refused to repair existing TASKMUX_HOME. No files or permissions were changed."
    );
  }
  ensureTaskmuxHome(taskmuxHome, { repairExisting: inspection.identity });
}

function setupCliIdentity(env: NodeJS.ProcessEnv): CliIdentity {
  return env.TASKMUX_CLI_NAME === "taskmux-dev" ? "taskmux-dev" : "taskmux";
}

export function validateSetupInvocation(args: string[], io: SetupIo = {}): void {
  parseSetupOptions(args);

  if (!shouldPrompt(io)) {
    throw setupRequiresInteractiveError();
  }
}

function setupRequiresInteractiveError(): ReturnType<typeof usageError> {
  return usageError(
    "Setup requires an interactive terminal. Use taskmux config set default-agent <agent-id> and taskmux config set default-workspace <path> for scripted changes."
  );
}

function createSetupQuestion(
  readline: ReturnType<typeof createInterface>,
  io: InteractiveSetupIo
): SetupQuestion {
  if (io.input.isTTY === true) {
    return (prompt) => readline.question(prompt);
  }

  const lineIterator = readline[Symbol.asyncIterator]();

  return async (prompt) => {
    io.output.write(prompt);
    const nextLine = await lineIterator.next();

    return nextLine.done === true ? "skip" : nextLine.value;
  };
}

async function promptForRequiredConfig(
  store: TaskStore,
  taskmuxHome: string,
  env: NodeJS.ProcessEnv,
  io: SetupIo,
  question: (prompt: string) => Promise<string>
): Promise<SetupConfigResult> {
  const config = store.getConfig();
  const agents = store.listConfiguredAgents();
  const currentDefaultAgent = config.defaultAgent?.trim() ?? "";
  const currentAgentDefinition =
    currentDefaultAgent.length === 0 ? null : resolveAgent(currentDefaultAgent, agents);
  const options = buildSetupAgentOptions(agents, env, currentAgentDefinition?.id ?? currentDefaultAgent);
  const defaultOption = resolveDefaultAgentOption(options);
  const table = renderTable(
    "Default agent candidates",
    [
      { header: "#", minWidth: 1, maxWidth: 3 },
      { header: "Agent", minWidth: 5, maxWidth: 14 },
      { header: "Command", minWidth: 7, maxWidth: 16 },
      { header: "Status", minWidth: 7, maxWidth: 19 },
      { header: "Current", minWidth: 7, maxWidth: 8 },
      { header: "Note", minWidth: 10, maxWidth: 52 }
    ],
    options.map((option) => [
      String(option.index),
      option.name,
      option.executable,
      option.status,
      option.current ? "yes" : "",
      option.description
    ]),
    tableWidth(io)
  );
  const answer = await question(`${table}\nChoose default agent by number or name [${defaultOption?.name ?? "none"}]: `);
  const selectedAgent = parseAgentSelection(answer, options, defaultOption);
  const selectedAgentName = selectedAgent.name;

  const existingAgent = store.getConfiguredAgent(selectedAgentName);
  const enrolledPin = enrollAgentCapabilityProbePin(
    { adapterId: selectedAgent.adapterId, command: selectedAgent.command },
    env
  );
  const configuredAgent = existingAgent === null || existingAgent.adapterId !== selectedAgent.adapterId
    ? createConfiguredAgent(
      selectedAgentName,
      selectedAgent.adapterId,
      selectedAgent.command,
      [],
      [],
      new Date(),
      enrolledPin
    )
    : createConfiguredAgent(
      existingAgent.id,
      existingAgent.adapterId,
      existingAgent.command,
      existingAgent.baseArgs,
      existingAgent.environment,
      new Date(),
      enrolledPin ?? existingAgent.probePin,
      enrolledPin === undefined && existingAgent.probePin === undefined
        ? existingAgent.probePinRefreshRequired
        : undefined
    );
  const defaultAgent = configuredAgentToDefinition(configuredAgent);

  const defaultWorkspace = setupWorkspace(taskmuxHome);
  mkdirSync(defaultWorkspace, { recursive: true });

  return {
    configuredAgent,
    defaultAgent,
    defaultWorkspace
  };
}

function setupWorkspace(taskmuxHome: string): string {
  return join(taskmuxHome, "workspace");
}

function buildSetupAgentOptions(
  configuredAgents: ReturnType<TaskStore["listConfiguredAgents"]>,
  env: NodeJS.ProcessEnv,
  currentAgent: string
): SetupAgentOption[] {
  const configuredDefinitions = configuredAgents
    .map(configuredAgentToDefinition)
    .filter(isSupportedSessionAgent);
  const configuredById = new Map(configuredDefinitions
    .filter((definition) => setupAgentChoices.some((choice) =>
      choice.name === definition.id && choice.adapterId === definition.adapterId
    ))
    .map((definition) => [definition.id, definition]));
  const definitions = [
    ...setupAgentChoices.map((choice) => configuredById.get(choice.name) ?? configuredAgentToDefinition(
      createConfiguredAgent(choice.name, choice.adapterId, choice.name, [], [], new Date())
    )),
    ...configuredDefinitions
      .filter((agent) => !setupAgentChoices.some((choice) => choice.name === agent.id))
  ];

  return definitions.map((definition, index) => {
    const adapter = findAgentAdapter(definition.adapterId);
    if (adapter === null) throw new Error(`Unsupported setup adapter: ${definition.adapterId}.`);
    const enrolledProbePin = definition.probePin ?? enrollAgentCapabilityProbePin(
      { adapterId: definition.adapterId, command: definition.command },
      env
    );
    const probeDefinition = enrolledProbePin === undefined
      ? definition
      : { ...definition, probePin: enrolledProbePin };
    const installation = adapter.probeInstallation(probeDefinition, new Date(), env);
    const presented = presentAgentDefinition(definition);
    const status = installation.status === "installed"
      ? "installed" as const
      : installation.status === "unsupported-version"
        ? "unsupported version" as const
        : installation.status === "probe-failed"
          ? "probe failed" as const
          : installation.status === "unsafe-output"
            ? "unsafe probe output" as const
            : installation.status === "unavailable"
              ? "live probe unavailable" as const
              : installation.status === "refresh-required"
                ? "refresh required" as const
                : "missing" as const;
    const builtin = setupAgentChoices.find((choice) => choice.name === definition.id);
    return {
      name: definition.id,
      adapterId: definition.adapterId,
      command: definition.command,
      executable: presented.executable,
      description: builtin?.description ?? `Configured ${definition.adapterId} agent`,
      index: index + 1,
      status,
      selectable: installation.status === "installed" || installation.status === "unavailable",
      current: definition.id === currentAgent
    };
  });
}

function isSupportedSessionAgent(definition: AgentDefinition): boolean {
  const adapter = findAgentAdapter(definition.adapterId);
  return adapter !== null &&
    adapter.capabilities.recover &&
    adapter.capabilities.nativeSessionDiscovery !== "none";
}

function parseAgentSelection(
  input: string,
  options: SetupAgentOption[],
  defaultOption: SetupAgentOption | undefined
): SetupAgentOption {
  const value = input.trim();

  if (value.length === 0) {
    if (defaultOption === undefined) {
      throw usageError("No installed Codex or Claude agent is available for the Operator and Leader roles.");
    }
    return defaultOption;
  }

  let option: SetupAgentOption | undefined;
  if (/^\d+$/.test(value)) {
    const index = Number.parseInt(value, 10);
    option = options.find((candidate) => candidate.index === index);

    if (option === undefined) {
      throw usageError(`Agent selection must be between 1 and ${options.length}, or a listed agent name.`);
    }
  } else {
    option = options.find((candidate) => candidate.name === value);
    if (option === undefined) {
      throw usageError(`Agent ${value} is not a listed Codex or Claude definition. Configure it with taskmux agent add first.`);
    }
  }

  if (!option.selectable) {
    throw usageError(
      `Agent ${option.name} cannot be used for the Operator or Leader roles: ${option.status}.`
    );
  }
  return option;
}

function resolveDefaultAgentOption(options: SetupAgentOption[]): SetupAgentOption | undefined {
  const currentOption = options.find((option) => option.current && option.selectable);

  if (currentOption !== undefined) {
    return currentOption;
  }
  return options.find((option) => option.selectable);
}

function tableWidth(io: SetupIo): number {
  return io.output?.columns === undefined ? defaultTableWidth() : Math.max(46, Math.min(io.output.columns, 140));
}

function shouldPrompt(io: SetupIo): io is InteractiveSetupIo {
  return io.input !== undefined && io.output !== undefined && (io.forceInteractive === true || io.input.isTTY === true);
}

export function setupSystemRoles(
  store: TaskStore,
  agent: AgentDefinition | null,
  workspace: string | undefined,
  now = new Date(),
  probeRuntime?: SetupRoleRuntimeProbe
): void {
  if (agent === null) {
    return;
  }

  if (workspace === undefined || workspace.length === 0) {
    return;
  }

  for (const roleName of [SYSTEM_OPERATOR_ROLE, SYSTEM_LEADER_ROLE]) {
    const existing = store.getGlobalRole(roleName);
    if (existing === null) {
      store.saveGlobalRoleWithSessionSet(
        createGlobalRole(roleName, [createRoleAgentBinding(agent)], agent.id, workspace, now),
        null
      );
      continue;
    }

    const currentBinding = existing.agentBindings[agent.id];
    const bindingMatches = currentBinding?.adapterId === agent.adapterId;
    if (bindingMatches && existing.activeAgentId === agent.id) {
      store.saveGlobalRoleWithSessionSet(existing, store.getGlobalRoleSessionSet(roleName));
      continue;
    }
    const agentBindings = bindingMatches
      ? existing.agentBindings
      : { ...existing.agentBindings, [agent.id]: createRoleAgentBinding(agent) };
    if (probeRuntime === undefined) {
      throw usageError("Setup requires the system Role runtime guard before switching Agents.");
    }
    const sessionSet = store.getGlobalRoleSessionSet(roleName) ?? createRoleSessionSet(
      { scope: "global", roleName },
      existing.activeAgentId,
      now
    );
    const boundRole = bindingMatches
      ? existing
      : updateGlobalRole(existing, { agentBindings }, now);
    const switched = switchActiveRoleAgent(
      boundRole,
      sessionSet,
      agent.id,
      probeRuntime(roleName),
      now
    );
    store.saveGlobalRoleWithSessionSet(switched.role, switched.sessions);
  }
}

export function commitSetupSystemState(
  store: FileTaskStore,
  configuredAgent: ConfiguredAgent,
  workspace: string,
  tmux: SetupTmuxProbe,
  now = new Date()
): void {
  const persist = (transactionStore: FileTaskStore): void => {
    const existingAgent = transactionStore.getConfiguredAgent(configuredAgent.id);
    const persistedAgent = existingAgent === null
      ? transactionStore.createConfiguredAgentIfAbsent(configuredAgent)
      : sameSetupAgentConfiguration(existingAgent, configuredAgent)
        ? existingAgent
      : transactionStore.updateConfiguredAgent(
        configuredAgent.id,
        {
          adapterId: configuredAgent.adapterId,
          command: configuredAgent.command,
          baseArgs: configuredAgent.baseArgs,
          environment: configuredAgent.environment,
          probePin: configuredAgent.probePin ?? null,
          probePinRefreshRequired: configuredAgent.probePinRefreshRequired ?? null
        },
        new Date(configuredAgent.updatedAt)
      )?.agent ?? null;
    if (persistedAgent === null) {
      throw usageError(`Agent registry changed during setup: ${configuredAgent.id}. Run setup again.`);
    }
    transactionStore.saveConfig({
      ...transactionStore.getConfig(),
      defaultAgent: persistedAgent.id,
      defaultWorkspace: workspace
    });
    setupSystemRoles(
      transactionStore,
      configuredAgentToDefinition(persistedAgent),
      workspace,
      now,
      (roleName) => ({
        activeRun: transactionStore.getActiveAgentRun("operator", roleName) !== null,
        nativeProcessRunning: tmux.probeRoleStatus("operator", roleName) === "running"
      })
    );
  };
  if (hasActiveDomainTransactionAuthority(store.rootDirectory())) {
    persist(store);
    return;
  }
  executeDomainTransaction(store.rootDirectory(), `setup-${randomUUID()}`, (workingRoot) => {
    persist(new FileTaskStore(workingRoot));
  });
}

function sameSetupAgentConfiguration(left: ConfiguredAgent, right: ConfiguredAgent): boolean {
  return left.adapterId === right.adapterId &&
    left.command === right.command &&
    left.baseArgs.length === right.baseArgs.length &&
    left.baseArgs.every((value, index) => value === right.baseArgs[index]) &&
    left.environment.length === right.environment.length &&
    left.environment.every((binding, index) => {
      const candidate = right.environment[index];
      return candidate !== undefined &&
        binding.target === candidate.target &&
        binding.source === candidate.source &&
        binding.sourceName === candidate.sourceName &&
        binding.required === candidate.required;
    }) &&
    JSON.stringify(left.probePin) === JSON.stringify(right.probePin) &&
    left.probePinRefreshRequired === right.probePinRefreshRequired;
}

function parseSetupOptions(args: string[]): SetupOptions {
  let dependency: SetupDependency | undefined;

  for (const arg of args) {
    if (arg === "tmux") {
      dependency = "tmux";
      continue;
    }

    throw usageError("Setup usage: taskmux setup [tmux]");
  }

  return { dependency };
}

async function setupTmux(env: NodeJS.ProcessEnv, executor: CommandExecutor, question: SetupQuestion): Promise<string[]> {
  const tmuxCommand = env.TASKMUX_TMUX_BIN ?? "tmux";

  if (hasExecutable(tmuxCommand, ["-V"], executor)) {
    return ["Tmux already installed."];
  }

  const plan = detectTmuxInstallPlan(env, executor);

  if (plan === null) {
    return [
      "Tmux is not installed.",
      "Install tmux manually, then run taskmux doctor."
    ];
  }

  const lines = [
    "Tmux is not installed.",
    `Install with ${plan.manager}:`,
    ...plan.steps.map((step) => `  ${renderStep(step)}`)
  ];

  const answer = (await question("Install tmux now? [y/N]: ")).trim().toLowerCase();

  if (answer !== "y" && answer !== "yes") {
    return [
      ...lines,
      "Skipped tmux installation.",
      "After installing tmux, run taskmux doctor."
    ];
  }

  for (const step of plan.steps) {
    executor.run(step.command, step.args, { inheritStdio: true });
  }

  if (!hasExecutable(tmuxCommand, ["-V"], executor)) {
    return [
      ...lines,
      `Tmux install command completed, but ${tmuxCommand} is still unavailable.`,
      plan.manualHint
    ];
  }

  return [
    ...lines,
    "Tmux installed."
  ];
}

function detectTmuxInstallPlan(env: NodeJS.ProcessEnv, executor: CommandExecutor): InstallPlan | null {
  if (process.platform === "darwin" && commandExists("brew", env, executor)) {
    return {
      manager: "Homebrew",
      steps: [{ command: "brew", args: ["install", "tmux"] }],
      manualHint: "brew install tmux"
    };
  }

  if (process.platform !== "linux") {
    return null;
  }

  if (commandExists("apt-get", env, executor)) {
    const updateStep = withLinuxPrivilege("apt-get", ["update"], env, executor);
    const installStep = withLinuxPrivilege("apt-get", ["install", "-y", "tmux"], env, executor);

    if (updateStep === null || installStep === null) {
      return null;
    }

    return {
      manager: "apt-get",
      steps: [updateStep, installStep],
      manualHint: "sudo apt-get update && sudo apt-get install -y tmux"
    };
  }

  if (commandExists("dnf", env, executor)) {
    const installStep = withLinuxPrivilege("dnf", ["install", "-y", "tmux"], env, executor);

    if (installStep === null) {
      return null;
    }

    return {
      manager: "dnf",
      steps: [installStep],
      manualHint: "sudo dnf install -y tmux"
    };
  }

  if (commandExists("pacman", env, executor)) {
    const installStep = withLinuxPrivilege("pacman", ["-S", "--noconfirm", "tmux"], env, executor);

    if (installStep === null) {
      return null;
    }

    return {
      manager: "pacman",
      steps: [installStep],
      manualHint: "sudo pacman -S --noconfirm tmux"
    };
  }

  if (commandExists("apk", env, executor)) {
    const installStep = withLinuxPrivilege("apk", ["add", "tmux"], env, executor);

    if (installStep === null) {
      return null;
    }

    return {
      manager: "apk",
      steps: [installStep],
      manualHint: "sudo apk add tmux"
    };
  }

  return null;
}

function hasExecutable(command: string, args: string[], executor: CommandExecutor): boolean {
  try {
    executor.run(command, args);
    return true;
  } catch {
    return false;
  }
}

function commandExists(command: string, env: NodeJS.ProcessEnv, executor: CommandExecutor): boolean {
  if (command.includes("/")) {
    return existsSync(command);
  }

  const pathValue = env.PATH ?? "";
  const pathEntries = pathValue.split(delimiter).filter((entry) => entry.length > 0);

  if (pathEntries.some((entry) => existsSync(join(entry, command)))) {
    return true;
  }

  return hasExecutable(command, ["--version"], executor);
}

function withLinuxPrivilege(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  executor: CommandExecutor
): InstallStep | null {
  if (process.getuid?.() === 0) {
    return { command, args };
  }

  if (!commandExists("sudo", env, executor)) {
    return null;
  }

  return { command: "sudo", args: [command, ...args] };
}

function renderStep(step: InstallStep): string {
  return [step.command, ...step.args].join(" ");
}
