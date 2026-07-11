import { existsSync, mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { createGlobalRole } from "../role/role.js";
import { SYSTEM_LEADER_ROLE, SYSTEM_OPERATOR_ROLE } from "../role/systemRoles.js";
import { createCustomRunner } from "../runner/runner.js";
import type { RunnerDefinition } from "../runner/runner.js";
import { resolveRunner } from "../runner/runnerRegistry.js";
import { ensureTaskmuxHome, FileTaskStore, resolveTaskmuxHome, type TaskStore } from "../storage/taskStore.js";
import { ensureStorageSchema } from "../storage/storageSchema.js";
import type { CommandRunner } from "../tmux/commandRunner.js";

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
  description: string;
};

type SetupAgentOption = SetupAgentChoice & {
  index: number;
  installed: boolean;
  current: boolean;
};

type SetupConfigResult = {
  defaultAgent: RunnerDefinition | null;
  defaultWorkspace: string | undefined;
};

type SetupQuestion = (prompt: string) => Promise<string>;

const setupAgentChoices: SetupAgentChoice[] = [
  { name: "codex", description: "OpenAI Codex CLI" },
  { name: "claude", description: "Anthropic Claude Code" },
  { name: "gemini", description: "Google Gemini CLI" },
  { name: "qwen", description: "Qwen Code" },
  { name: "opencode", description: "OpenCode" },
  { name: "aider", description: "Aider" },
  { name: "copilot", description: "GitHub Copilot CLI" }
];

export async function runSetupCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  runner: CommandRunner,
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

    ensureTaskmuxHome(taskmuxHome);
    ensureStorageSchema(taskmuxHome);

    const store = new FileTaskStore(taskmuxHome);
    const configResult = await promptForRequiredConfig(store, taskmuxHome, env, io, question);

    setupSystemRoles(store, configResult.defaultAgent, configResult.defaultWorkspace);
    outputLines.push("TaskMux home initialized.");
    outputLines.push("Workspace initialized under TaskMux home.");

    for (const dependency of dependencies) {
      if (dependency === "tmux") {
        outputLines.push(...await setupTmux(env, runner, question));
      }
    }

    outputLines.push("TaskMux setup complete.");

    return `${outputLines.join("\n")}\n`;
  } finally {
    readline.close();
  }
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

    return nextLine.done === true ? "" : nextLine.value;
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
  const customRunners = store.listCustomRunners();
  const currentDefaultAgent = config.defaultAgent?.trim() ?? "";
  const currentDefaultRunner =
    currentDefaultAgent.length === 0 ? null : resolveRunner(currentDefaultAgent, customRunners);
  const options = buildSetupAgentOptions(env, currentDefaultRunner?.id ?? currentDefaultAgent);
  const defaultOption = resolveDefaultAgentOption(options, currentDefaultRunner?.id ?? currentDefaultAgent, env);
  const table = renderTable(
    "Default agent candidates",
    [
      { header: "#", minWidth: 1, maxWidth: 3 },
      { header: "Agent", minWidth: 5, maxWidth: 14 },
      { header: "Command", minWidth: 7, maxWidth: 14 },
      { header: "Status", minWidth: 7, maxWidth: 9 },
      { header: "Current", minWidth: 7, maxWidth: 8 },
      { header: "Note", minWidth: 10, maxWidth: 52 }
    ],
    options.map((option) => [
      String(option.index),
      option.name,
      option.name,
      option.installed ? "installed" : "missing",
      option.current ? "yes" : "",
      option.description
    ]),
    tableWidth(io)
  );
  const answer = await question(`${table}\nChoose default agent by number or name [${defaultOption.name}]: `);
  const selectedAgent = parseAgentSelection(answer, options, defaultOption, env);
  const selectedAgentName = selectedAgent.name;

  const existingAgent = resolveRunner(selectedAgentName, store.listCustomRunners());

  if (existingAgent === null) {
    const agent = createCustomRunner(selectedAgentName, selectedAgentName, [], {}, new Date());

    store.saveCustomRunner(agent);
  }

  const defaultAgent = resolveRunner(selectedAgentName, store.listCustomRunners());

  if (defaultAgent === null) {
    throw usageError(`${selectedAgentName} is not configured.`);
  }

  const defaultWorkspace = setupWorkspace(taskmuxHome);
  mkdirSync(defaultWorkspace, { recursive: true });

  store.saveConfig({
    ...store.getConfig(),
    defaultAgent: selectedAgentName,
    defaultWorkspace
  });

  return {
    defaultAgent,
    defaultWorkspace
  };
}

function setupWorkspace(taskmuxHome: string): string {
  return join(taskmuxHome, "workspace");
}

function buildSetupAgentOptions(env: NodeJS.ProcessEnv, currentAgent: string): SetupAgentOption[] {
  const options = setupAgentChoices.map((choice, index) => ({
    ...choice,
    index: index + 1,
    installed: commandOnPath(choice.name, env),
    current: choice.name === currentAgent
  }));

  if (currentAgent.length > 0 && options.every((option) => option.name !== currentAgent)) {
    options.push({
      name: currentAgent,
      description: "Current custom agent",
      index: options.length + 1,
      installed: commandOnPath(currentAgent, env),
      current: true
    });
  }

  return options;
}

function commandOnPath(command: string, env: NodeJS.ProcessEnv): boolean {
  if (command.includes("/") || command.includes("\\")) {
    return existsSync(command);
  }

  const pathEntries = (env.PATH ?? "").split(delimiter).filter((entry) => entry.length > 0);
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter((entry) => entry.length > 0)
      : [""];

  return pathEntries.some((entry) =>
    extensions.some((extension) => existsSync(join(entry, `${command}${extension}`)))
  );
}

function parseAgentSelection(
  input: string,
  options: SetupAgentOption[],
  defaultOption: SetupAgentOption,
  env: NodeJS.ProcessEnv
): SetupAgentOption {
  const value = input.trim();

  if (value.length === 0) {
    return defaultOption;
  }

  if (/^\d+$/.test(value)) {
    const index = Number.parseInt(value, 10);
    const option = options.find((candidate) => candidate.index === index);

    if (option === undefined) {
      throw usageError(`Agent selection must be between 1 and ${options.length}, or a custom agent name.`);
    }

    return option;
  }

  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw usageError("Agent name may only contain letters, numbers, hyphens, and underscores.");
  }

  return {
    name: value,
    description: "Custom agent",
    index: options.length + 1,
    installed: commandOnPath(value, env),
    current: false
  };
}

function resolveDefaultAgentOption(
  options: SetupAgentOption[],
  currentAgent: string,
  env: NodeJS.ProcessEnv
): SetupAgentOption {
  const currentOption = options.find((option) => option.current);

  if (currentOption !== undefined) {
    return currentOption;
  }

  if (currentAgent.length > 0) {
    return {
      name: currentAgent,
      description: "Current custom agent",
      index: options.length + 1,
      installed: commandOnPath(currentAgent, env),
      current: true
    };
  }

  return options.find((option) => option.installed) ?? options[0];
}

function tableWidth(io: SetupIo): number {
  return io.output?.columns === undefined ? defaultTableWidth() : Math.max(46, Math.min(io.output.columns, 140));
}

function shouldPrompt(io: SetupIo): io is InteractiveSetupIo {
  return io.input !== undefined && io.output !== undefined && (io.forceInteractive === true || io.input.isTTY === true);
}

function setupSystemRoles(store: TaskStore, agent: RunnerDefinition | null, workspace: string | undefined): void {
  if (agent === null) {
    return;
  }

  if (workspace === undefined || workspace.length === 0) {
    return;
  }

  for (const roleName of [SYSTEM_OPERATOR_ROLE, SYSTEM_LEADER_ROLE]) {
    store.saveGlobalRole(createGlobalRole(roleName, agent, workspace, new Date()));
  }
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

async function setupTmux(env: NodeJS.ProcessEnv, runner: CommandRunner, question: SetupQuestion): Promise<string[]> {
  const tmuxCommand = env.TASKMUX_TMUX_BIN ?? "tmux";

  if (hasExecutable(tmuxCommand, ["-V"], runner)) {
    return ["Tmux already installed."];
  }

  const plan = detectTmuxInstallPlan(env, runner);

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
    runner.run(step.command, step.args, { inheritStdio: true });
  }

  if (!hasExecutable(tmuxCommand, ["-V"], runner)) {
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

function detectTmuxInstallPlan(env: NodeJS.ProcessEnv, runner: CommandRunner): InstallPlan | null {
  if (process.platform === "darwin" && commandExists("brew", env, runner)) {
    return {
      manager: "Homebrew",
      steps: [{ command: "brew", args: ["install", "tmux"] }],
      manualHint: "brew install tmux"
    };
  }

  if (process.platform !== "linux") {
    return null;
  }

  if (commandExists("apt-get", env, runner)) {
    const updateStep = withLinuxPrivilege("apt-get", ["update"], env, runner);
    const installStep = withLinuxPrivilege("apt-get", ["install", "-y", "tmux"], env, runner);

    if (updateStep === null || installStep === null) {
      return null;
    }

    return {
      manager: "apt-get",
      steps: [updateStep, installStep],
      manualHint: "sudo apt-get update && sudo apt-get install -y tmux"
    };
  }

  if (commandExists("dnf", env, runner)) {
    const installStep = withLinuxPrivilege("dnf", ["install", "-y", "tmux"], env, runner);

    if (installStep === null) {
      return null;
    }

    return {
      manager: "dnf",
      steps: [installStep],
      manualHint: "sudo dnf install -y tmux"
    };
  }

  if (commandExists("pacman", env, runner)) {
    const installStep = withLinuxPrivilege("pacman", ["-S", "--noconfirm", "tmux"], env, runner);

    if (installStep === null) {
      return null;
    }

    return {
      manager: "pacman",
      steps: [installStep],
      manualHint: "sudo pacman -S --noconfirm tmux"
    };
  }

  if (commandExists("apk", env, runner)) {
    const installStep = withLinuxPrivilege("apk", ["add", "tmux"], env, runner);

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

function hasExecutable(command: string, args: string[], runner: CommandRunner): boolean {
  try {
    runner.run(command, args);
    return true;
  } catch {
    return false;
  }
}

function commandExists(command: string, env: NodeJS.ProcessEnv, runner: CommandRunner): boolean {
  if (command.includes("/")) {
    return existsSync(command);
  }

  const pathValue = env.PATH ?? "";
  const pathEntries = pathValue.split(delimiter).filter((entry) => entry.length > 0);

  if (pathEntries.some((entry) => existsSync(join(entry, command)))) {
    return true;
  }

  return hasExecutable(command, ["--version"], runner);
}

function withLinuxPrivilege(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  runner: CommandRunner
): InstallStep | null {
  if (process.getuid?.() === 0) {
    return { command, args };
  }

  if (!commandExists("sudo", env, runner)) {
    return null;
  }

  return { command: "sudo", args: [command, ...args] };
}

function renderStep(step: InstallStep): string {
  return [step.command, ...step.args].join(" ");
}
