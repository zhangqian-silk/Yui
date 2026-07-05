import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { usageError } from "../errors/cliError.js";
import { renderTable } from "../output/table.js";
import { createGlobalRole } from "../role/role.js";
import { SYSTEM_ASSISTANT_ROLE, SYSTEM_OWNER_ROLE } from "../role/systemRoles.js";
import { createCustomRunner } from "../runner/runner.js";
import { resolveRunner } from "../runner/runnerRegistry.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { CommandRunner } from "../tmux/commandRunner.js";

export type SetupDependency = "tmux";

type SetupOptions = {
  dependency?: SetupDependency;
  yes: boolean;
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

type SetupIo = {
  input?: Readable & { isTTY?: boolean };
  output?: Writable & { columns?: number };
  forceInteractive?: boolean;
};

type SetupAgentChoice = {
  name: string;
  description: string;
};

type SetupAgentOption = SetupAgentChoice & {
  index: number;
  installed: boolean;
  current: boolean;
};

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
  store?: TaskStore,
  io: SetupIo = {}
): Promise<string> {
  const options = parseSetupOptions(args);
  const dependencies: SetupDependency[] = options.dependency === undefined ? ["tmux"] : [options.dependency];
  const lines: string[] = [];

  if (store !== undefined) {
    lines.push(...await setupRequiredConfig(store, env, io));
    lines.push(...setupSystemRoles(store));
  }

  for (const dependency of dependencies) {
    if (dependency === "tmux") {
      lines.push(...setupTmux(options.yes, env, runner));
    }
  }

  return `TaskMux setup\n${renderStatusTable(lines, tableWidth(io))}\n`;
}

async function setupRequiredConfig(store: TaskStore, env: NodeJS.ProcessEnv, io: SetupIo): Promise<string[]> {
  if (!shouldPrompt(io)) {
    return setupRequiredConfigStatus(store);
  }

  const readline = createInterface({
    input: io.input,
    output: io.output,
    terminal: io.input?.isTTY === true
  });

  try {
    if (io.input?.isTTY === true) {
      return await promptForRequiredConfig(store, env, io, (question) => readline.question(question));
    }

    const lineIterator = readline[Symbol.asyncIterator]();

    return await promptForRequiredConfig(store, env, io, async (prompt) => {
      io.output?.write(prompt);
      const nextLine = await lineIterator.next();
      return nextLine.done === true ? "" : nextLine.value;
    });
  } finally {
    readline.close();
  }
}

function setupRequiredConfigStatus(store: TaskStore): string[] {
  const config = store.getConfig();
  const customRunners = store.listCustomRunners();
  const agent =
    config.defaultAgent === undefined || config.defaultAgent.length === 0
      ? null
      : resolveRunner(config.defaultAgent, customRunners);
  const lines = [
    "config\tmode\tnon-interactive",
    "config\tnext\tRun taskmux setup in an interactive terminal to configure defaults."
  ];

  if (agent !== null) {
    lines.push(`config\tok\tagent=${agent.id} workspace=${config.defaultWorkspace ?? "(none)"}`);
  } else if (config.defaultAgent !== undefined && config.defaultAgent.length > 0) {
    lines.push(`default-agent\tinvalid\t${config.defaultAgent} is not configured.`);
  } else {
    lines.push("config\tmissing\tRun taskmux setup.");
  }

  return lines;
}

async function promptForRequiredConfig(
  store: TaskStore,
  env: NodeJS.ProcessEnv,
  io: SetupIo,
  question: (prompt: string) => Promise<string>
): Promise<string[]> {
  const lines = ["config\tmode\tinteractive"];
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
  const selectedAgentInstalled = selectedAgent.installed;

  const existingAgent = resolveRunner(selectedAgentName, store.listCustomRunners());
  const agentCheck = selectedAgentInstalled ? "found in PATH" : "not found in PATH";

  if (existingAgent === null) {
    const agent = createCustomRunner(selectedAgentName, selectedAgentName, [], {}, new Date());

    store.saveCustomRunner(agent);
    lines.push(`agent\tconfigured\t${agent.id} command=${agent.command}; ${agentCheck}`);
  } else {
    lines.push(`agent\tok\t${existingAgent.id} command=${existingAgent.command}; ${agentCheck}`);
  }

  const currentWorkspace = config.defaultWorkspace?.trim() ?? "";
  const fallbackWorkspace = currentWorkspace || process.cwd();
  const workspaceAnswer = await question(`Default workspace [${fallbackWorkspace}]: `);
  const defaultWorkspace = resolve(workspaceAnswer.trim() || fallbackWorkspace);

  store.saveConfig({
    ...store.getConfig(),
    defaultAgent: selectedAgentName,
    defaultWorkspace
  });

  lines.push(`config\tconfigured\tagent=${selectedAgentName} workspace=${defaultWorkspace}`);

  return lines;
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
  return Math.max(46, Math.min(io.output?.columns ?? process.stdout.columns ?? 100, 140));
}

function renderStatusTable(lines: string[], maxWidth: number): string {
  return renderTable(
    "Status",
    [
      { header: "Item", minWidth: 8, maxWidth: 22 },
      { header: "Status", minWidth: 7, maxWidth: 16 },
      { header: "Detail", minWidth: 12, maxWidth: 88 }
    ],
    lines.map((line) => {
      const [item = "", status = "", ...detailParts] = line.split("\t");

      return [item, status, detailParts.join(" ")];
    }),
    maxWidth
  );
}

function shouldPrompt(io: SetupIo): io is Required<Pick<SetupIo, "input" | "output">> & SetupIo {
  return io.input !== undefined && io.output !== undefined && (io.forceInteractive === true || io.input.isTTY === true);
}

function setupSystemRoles(store: TaskStore): string[] {
  const config = store.getConfig();

  if (config.defaultAgent === undefined || config.defaultAgent.length === 0) {
    return [
      `${SYSTEM_ASSISTANT_ROLE}\tpending\tagent=?`,
      `${SYSTEM_OWNER_ROLE}\tpending\tagent=?`
    ];
  }

  const agent = resolveRunner(config.defaultAgent, store.listCustomRunners());

  if (agent === null) {
    return [
      `${SYSTEM_ASSISTANT_ROLE}\tpending\tagent=?`,
      `${SYSTEM_OWNER_ROLE}\tpending\tagent=?`
    ];
  }

  const workspace = config.defaultWorkspace ?? process.cwd();

  for (const roleName of [SYSTEM_ASSISTANT_ROLE, SYSTEM_OWNER_ROLE]) {
    store.saveGlobalRole(createGlobalRole(roleName, agent, workspace, new Date()));
  }

  return [
    `${SYSTEM_ASSISTANT_ROLE}\tconfigured\tagent=${agent.id} workspace=${workspace}`,
    `${SYSTEM_OWNER_ROLE}\tconfigured\tagent=${agent.id} workspace=${workspace}`
  ];
}

function parseSetupOptions(args: string[]): SetupOptions {
  let dependency: SetupDependency | undefined;
  let yes = false;

  for (const arg of args) {
    if (arg === "--yes" || arg === "-y") {
      yes = true;
      continue;
    }

    if (arg === "tmux") {
      dependency = "tmux";
      continue;
    }

    throw usageError("Setup usage: taskmux setup [tmux] [--yes]");
  }

  return { dependency, yes };
}

function setupTmux(yes: boolean, env: NodeJS.ProcessEnv, runner: CommandRunner): string[] {
  const tmuxCommand = env.TASKMUX_TMUX_BIN ?? "tmux";

  if (hasExecutable(tmuxCommand, ["-V"], runner)) {
    return ["tmux\tok\talready installed"];
  }

  const plan = detectTmuxInstallPlan(env, runner);

  if (plan === null) {
    return [
      "tmux\tmissing\tno supported package manager detected",
      "tmux\tmanual\tInstall tmux manually, then run taskmux doctor."
    ];
  }

  if (!yes) {
    return [
      `tmux\tmissing\tinstall with ${plan.manager}`,
      ...plan.steps.map((step) => `tmux\tplan\t${renderStep(step)}`),
      "tmux\tnext\tRun taskmux setup --yes to execute the install plan."
    ];
  }

  for (const step of plan.steps) {
    runner.run(step.command, step.args, { inheritStdio: true });
  }

  if (!hasExecutable(tmuxCommand, ["-V"], runner)) {
    return [
      `tmux\tinvalid\tinstall command completed, but ${tmuxCommand} is still unavailable`,
      `tmux\tmanual\t${plan.manualHint}`
    ];
  }

  return ["tmux\tok\tinstalled"];
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
