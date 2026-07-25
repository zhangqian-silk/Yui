import { existsSync, mkdirSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";

import {
  configuredAgentToDefinition,
  createConfiguredAgent,
  type ConfiguredAgent
} from "../agent/agent.js";
import type { AgentAdapterId } from "../agent/adapterCatalog.js";
import type { CliIdentity } from "../cli/completion.js";
import type { CompletionStore } from "../completion/completionInstaller.js";
import { runCompletionWizard } from "../completion/completionWizard.js";
import { usageError } from "../errors/cliError.js";
import { resolveAgentAdapter } from "../executor/agentAdapter.js";
import type { GlobalRoleSessionSet } from "../executor/agentExecutor.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { resolveTimeZone } from "../output/timePresentation.js";
import {
  createGlobalRole,
  createRoleAgentBinding,
  updateGlobalRole,
  type GlobalRole,
  type RoleAgentConfig
} from "../role/role.js";
import { SYSTEM_LEADER_ROLE, SYSTEM_OPERATOR_ROLE } from "../role/systemRoles.js";
import type { MailboxTarget, WorkMailbox } from "../coordination/workMailbox.js";
import { assertRoleRuntimeMutationAllowed } from "../commands/roleRuntimeGuard.js";
import {
  ensureYuiHome,
  FileTaskStore,
  resolveYuiHome
} from "../storage/taskStore.js";
import { ensureStorageSchema } from "../storage/storageSchema.js";
import type { CommandExecutor } from "../tmux/commandExecutor.js";

export type SetupDependency = "tmux";

export type SetupIo = Readonly<{
  input?: Readable & { isTTY?: boolean };
  output?: Writable & { columns?: number };
  forceInteractive?: boolean;
}>;

type InteractiveSetupIo = SetupIo & Required<Pick<SetupIo, "input" | "output">>;
type SetupQuestion = (prompt: string) => Promise<string>;

type SetupStore = Omit<CompletionStore, "transaction"> & Readonly<{
  transaction<T>(execute: (store: SetupStore) => T): T;
  listConfiguredAgents(): ConfiguredAgent[];
  getConfiguredAgent(id: string): ConfiguredAgent | null;
  saveConfiguredAgent(agent: ConfiguredAgent): void;
  getGlobalRole(name: string): GlobalRole | null;
  saveGlobalRole(role: GlobalRole): void;
  getGlobalRoleSessionSet(name: string): GlobalRoleSessionSet | null;
  getWorkMailbox(target: MailboxTarget): WorkMailbox | null;
}>;

type SetupAgentChoice = Readonly<{
  id: string;
  adapterId: AgentAdapterId;
  command: string;
  description: string;
}>;

type InstallStep = Readonly<{ command: string; args: string[] }>;
type InstallPlan = Readonly<{
  manager: string;
  steps: readonly InstallStep[];
  manualHint: string;
}>;

const BUILTIN_AGENTS: readonly SetupAgentChoice[] = Object.freeze([
  Object.freeze({
    id: "codex",
    adapterId: "codex",
    command: "codex",
    description: "OpenAI Codex CLI"
  }),
  Object.freeze({
    id: "claude",
    adapterId: "claude",
    command: "claude",
    description: "Anthropic Claude Code"
  })
]);

export async function runSetupCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  executor: CommandExecutor,
  io: SetupIo = {}
): Promise<string> {
  const dependency = parseSetupOptions(args);
  if (!shouldPrompt(io)) throw setupRequiresInteractiveError();

  const readline = createInterface({
    input: io.input,
    output: io.output,
    terminal: io.input.isTTY === true
  });
  try {
    const question = createSetupQuestion(readline, io);
    const home = resolveYuiHome(env);
    ensureYuiHome(home);
    ensureStorageSchema(home);
    const store = new FileTaskStore(home);

    const result = await configureYui(store, home, env, question, io);
    const lines = [
      "Yui home initialized.",
      `Agents configured: ${result.agentIds.join(", ")}.`,
      `Default Agent: ${result.defaultAgentId}.`,
      `Operator Agent: ${result.operatorAgentId}.`,
      `Leader model: ${result.leaderConfig.model ?? "CLI default"}.`,
      `Leader reasoning effort: ${result.leaderConfig.effort ?? "CLI default"}.`,
      `Operator model: ${result.operatorConfig.model ?? "CLI default"}.`,
      `Operator reasoning effort: ${result.operatorConfig.effort ?? "CLI default"}.`,
      `Operator workspace: ${result.workspace}.`,
      `Time zone: ${resolveTimeZone(new FileTaskStore(home).getConfig().timeZone)}.`
    ];
    if (dependency === undefined || dependency === "tmux") {
      lines.push(...await setupTmux(env, executor, question));
    }
    const completion = await runCompletionWizard(
      "install",
      store,
      env,
      cliIdentity(env),
      question,
      { width: tableWidth(io), defaultSelection: "skip" }
    );
    lines.push(completion.trimEnd());
    lines.push("Yui setup complete.");
    return `${lines.join("\n")}\n`;
  } finally {
    readline.close();
  }
}

export function validateSetupInvocation(args: readonly string[], io: SetupIo = {}): void {
  parseSetupOptions(args);
  if (!shouldPrompt(io)) throw setupRequiresInteractiveError();
}

async function configureYui(
  store: SetupStore,
  home: string,
  env: NodeJS.ProcessEnv,
  question: SetupQuestion,
  io: SetupIo
): Promise<Readonly<{
  agentIds: readonly string[];
  defaultAgentId: string;
  operatorAgentId: string;
  leaderConfig: RoleAgentConfig;
  operatorConfig: RoleAgentConfig;
  workspace: string;
}>> {
  const candidates = availableAgentChoices(store, env);
  if (candidates.length === 0) {
    throw usageError(
      "No supported Agent CLI was found. Install Codex or Claude, then run setup again."
    );
  }

  io.output?.write(`${renderTable(
    "Available Agents",
    [
      { header: "#", minWidth: 1, maxWidth: 3 },
      { header: "Agent", minWidth: 6, maxWidth: 16 },
      { header: "Adapter", minWidth: 7, maxWidth: 10 },
      { header: "Command", minWidth: 7, maxWidth: 24 },
      { header: "Description", minWidth: 12, maxWidth: 42 }
    ],
    candidates.map((candidate, index) => [
      String(index + 1),
      candidate.id,
      candidate.adapterId,
      candidate.command,
      candidate.description
    ]),
    tableWidth(io)
  )}\n`);
  const selected = parseAgentSetSelection(
    await question(
      `Choose Agents by number or name, comma-separated [all: ${candidates.map(({ id }) => id).join(", ")}]: `
    ),
    candidates
  );

  const now = new Date();
  const persisted = selected.map((choice) => persistAgent(store, choice, now));
  const configuredIds = new Set(persisted.map(({ id }) => id));
  const config = store.getConfig();
  const defaultFallback = configuredIds.has(config.defaultAgent ?? "")
    ? config.defaultAgent as string
    : persisted[0]?.id;
  if (defaultFallback === undefined) throw usageError("At least one Agent must be selected.");

  const defaultAgentId = parseSingleAgentSelection(
    await question(`Choose default Agent [${defaultFallback}]: `),
    persisted,
    defaultFallback
  );
  const currentOperatorAgent = store.getGlobalRole(SYSTEM_OPERATOR_ROLE)?.activeAgentId;
  const operatorFallback = configuredIds.has(currentOperatorAgent ?? "")
    ? currentOperatorAgent as string
    : defaultAgentId;
  const operatorAgentId = parseSingleAgentSelection(
    await question(`Choose Operator Agent [${operatorFallback}]: `),
    persisted,
    operatorFallback
  );
  const defaultAgent = persisted.find(({ id }) => id === defaultAgentId);
  const operatorAgent = persisted.find(({ id }) => id === operatorAgentId);
  if (defaultAgent === undefined || operatorAgent === undefined) {
    throw usageError("Selected setup Agent is no longer available.");
  }
  const leaderConfig = await promptRoleAgentConfig(
    "Leader",
    defaultAgent,
    store.getGlobalRole(SYSTEM_LEADER_ROLE),
    question
  );
  const operatorConfig = await promptRoleAgentConfig(
    "Operator",
    operatorAgent,
    store.getGlobalRole(SYSTEM_OPERATOR_ROLE),
    question
  );
  const suggestedWorkspace = config.defaultWorkspace?.trim() || join(home, "workspace");
  const workspaceAnswer = (await question(
    `Operator workspace [${suggestedWorkspace}]: `
  )).trim();
  const workspace = resolveWorkspace(workspaceAnswer || suggestedWorkspace);
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  store.transaction((tx) => {
    const latestDefaultAgent = requireSetupAgent(tx, defaultAgentId);
    const latestOperatorAgent = requireSetupAgent(tx, operatorAgentId);
    const operatorRole = prepareSystemRole(
      tx,
      SYSTEM_OPERATOR_ROLE,
      latestOperatorAgent,
      workspace,
      now,
      operatorConfig
    );
    const leaderRole = prepareSystemRole(
      tx,
      SYSTEM_LEADER_ROLE,
      latestDefaultAgent,
      workspace,
      now,
      leaderConfig
    );
    const latest = tx.getConfig();
    tx.saveConfig({
      ...latest,
      defaultAgent: defaultAgentId,
      defaultWorkspace: workspace,
      timeZone: resolveTimeZone(latest.timeZone)
    });
    if (operatorRole !== null) tx.saveGlobalRole(operatorRole);
    if (leaderRole !== null) tx.saveGlobalRole(leaderRole);
  });

  return {
    agentIds: persisted.map(({ id }) => id),
    defaultAgentId,
    operatorAgentId,
    leaderConfig,
    operatorConfig,
    workspace
  };
}

async function promptRoleAgentConfig(
  label: string,
  agent: ConfiguredAgent,
  existingRole: GlobalRole | null,
  question: SetupQuestion
): Promise<RoleAgentConfig> {
  const existing = existingRole?.activeAgentId === agent.id
    ? existingRole.agentBindings[agent.id]?.config
    : undefined;
  const model = await promptOptionalAgentSetting(
    label,
    "model",
    agent.id,
    existing?.model,
    question
  );
  const effort = await promptOptionalAgentSetting(
    label,
    "reasoning effort",
    agent.id,
    existing?.effort,
    question
  );
  const candidate = structuredClone(
    existing ?? { adapterId: agent.adapterId }
  ) as unknown as Record<string, unknown>;
  if (model === undefined) delete candidate.model;
  else candidate.model = model;
  if (effort === undefined) delete candidate.effort;
  else candidate.effort = effort;
  try {
    return resolveAgentAdapter(agent.adapterId).canonicalizeConfig(
      candidate as RoleAgentConfig
    );
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
}

async function promptOptionalAgentSetting(
  label: string,
  setting: string,
  agentId: string,
  current: string | undefined,
  question: SetupQuestion
): Promise<string | undefined> {
  const clearHint = current === undefined ? "" : ' (or "default" for CLI default)';
  const answer = (await question(
    `${label} ${setting} for ${agentId} [${current ?? "CLI default"}]${clearHint}: `
  )).trim();
  if (answer.length === 0) return current;
  return answer.toLowerCase() === "default" ? undefined : answer;
}

function availableAgentChoices(
  store: SetupStore,
  env: NodeJS.ProcessEnv
): SetupAgentChoice[] {
  const existing = new Map(store.listConfiguredAgents().map((agent) => [agent.id, agent]));
  return BUILTIN_AGENTS.flatMap((builtin) => {
    const configured = existing.get(builtin.id);
    const command = configured?.command ?? builtin.command;
    if (!commandOnPath(command, env)) return [];
    return [{
      ...builtin,
      adapterId: configured?.adapterId ?? builtin.adapterId,
      command
    }];
  });
}

function persistAgent(
  store: SetupStore,
  choice: SetupAgentChoice,
  now: Date
): ConfiguredAgent {
  const existing = store.getConfiguredAgent(choice.id);
  if (
    existing !== null
    && existing.adapterId === choice.adapterId
    && existing.command === choice.command
  ) {
    return existing;
  }
  const agent = createConfiguredAgent(
    choice.id,
    choice.adapterId,
    choice.command,
    existing?.baseArgs ?? [],
    existing?.environment ?? [],
    now
  );
  store.saveConfiguredAgent(agent);
  return agent;
}

function requireSetupAgent(
  store: SetupStore,
  agentId: string
): ConfiguredAgent {
  const agent = store.getConfiguredAgent(agentId);
  if (agent === null) throw usageError(`Configured Agent not found: ${agentId}.`);
  return agent;
}

function prepareSystemRole(
  store: SetupStore,
  name: string,
  agent: ConfiguredAgent,
  workspace: string,
  now: Date,
  config: RoleAgentConfig
): GlobalRole | null {
  const existing = store.getGlobalRole(name);
  if (existing !== null) {
    if (existing.activeAgentId !== agent.id || existing.workspace !== workspace) {
      throw usageError(
        `Global Role ${name} is already configured with Agent ${existing.activeAgentId} `
          + `and workspace ${existing.workspace}. Stop its Session and use role update before changing it.`
      );
    }
    const definition = configuredAgentToDefinition(agent);
    const binding = createRoleAgentBinding(definition, config);
    if (isDeepStrictEqual(existing.agentBindings[agent.id], binding)) return null;
    assertRoleRuntimeMutationAllowed(store, {
      scope: "global",
      roleName: name
    }, "launch configuration update");
    const session = store.getGlobalRoleSessionSet(name)?.sessions[agent.id];
    if (session !== undefined && session.status !== "stopped") {
      throw usageError(
        `Global Role ${name} Agent settings cannot be changed while its native process is running.`
      );
    }
    return updateGlobalRole(existing, {
      agentBindings: { ...existing.agentBindings, [agent.id]: binding }
    }, now);
  }
  assertRoleRuntimeMutationAllowed(store, {
    scope: "global",
    roleName: name
  }, "creation");
  const definition = configuredAgentToDefinition(agent);
  return createGlobalRole(
    name,
    [createRoleAgentBinding(definition, config)],
    definition.id,
    workspace,
    now
  );
}

function parseAgentSetSelection(
  answer: string,
  candidates: readonly SetupAgentChoice[]
): SetupAgentChoice[] {
  const value = answer.trim().toLowerCase();
  if (value.length === 0 || value === "all") return [...candidates];
  const tokens = value.split(",").map((token) => token.trim()).filter(Boolean);
  if (tokens.length === 0) throw usageError("Select at least one Agent.");
  const selected: SetupAgentChoice[] = [];
  for (const token of tokens) {
    const numeric = Number(token);
    const choice = Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= candidates.length
      ? candidates[numeric - 1]
      : candidates.find(({ id }) => id.toLowerCase() === token);
    if (choice === undefined) {
      throw usageError("Choose available Agents by number or name, separated by commas.");
    }
    if (!selected.some(({ id }) => id === choice.id)) selected.push(choice);
  }
  return selected;
}

function parseSingleAgentSelection(
  answer: string,
  agents: readonly ConfiguredAgent[],
  fallback: string
): string {
  const value = answer.trim().toLowerCase();
  if (value.length === 0) return fallback;
  const numeric = Number(value);
  const selected = Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= agents.length
    ? agents[numeric - 1]
    : agents.find(({ id }) => id.toLowerCase() === value);
  if (selected === undefined) {
    throw usageError("Choose one of the configured Agents by number or name.");
  }
  return selected.id;
}

function resolveWorkspace(value: string): string {
  if (!isAbsolute(value)) throw usageError("Operator workspace must be an absolute path.");
  return resolve(value);
}

function commandOnPath(command: string, env: NodeJS.ProcessEnv): boolean {
  if (command.includes("/") || command.includes("\\")) return existsSync(command);
  const entries = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  return entries.some((entry) => extensions.some((extension) =>
    existsSync(join(entry, `${command}${extension}`))
  ));
}

function createSetupQuestion(
  readline: ReturnType<typeof createInterface>,
  io: InteractiveSetupIo
): SetupQuestion {
  if (io.input.isTTY === true) return (prompt) => readline.question(prompt);
  const lines = readline[Symbol.asyncIterator]();
  return async (prompt) => {
    io.output.write(prompt);
    const line = await lines.next();
    return line.done ? "" : line.value;
  };
}

function shouldPrompt(io: SetupIo): io is InteractiveSetupIo {
  return io.input !== undefined
    && io.output !== undefined
    && (io.forceInteractive === true || io.input.isTTY === true);
}

function setupRequiresInteractiveError(): Error {
  return usageError("Setup requires an interactive terminal.");
}

function tableWidth(io: SetupIo): number {
  return io.output?.columns === undefined
    ? defaultTableWidth()
    : Math.max(46, Math.min(io.output.columns, 140));
}

function cliIdentity(env: NodeJS.ProcessEnv): CliIdentity {
  return env.YUI_CLI_NAME === "yui-dev" ? "yui-dev" : "yui";
}

function parseSetupOptions(args: readonly string[]): SetupDependency | undefined {
  if (args.length === 0) return undefined;
  if (args.length === 1 && args[0] === "tmux") return "tmux";
  throw usageError("Setup usage: yui setup [tmux]");
}

async function setupTmux(
  env: NodeJS.ProcessEnv,
  executor: CommandExecutor,
  question: SetupQuestion
): Promise<string[]> {
  const command = env.YUI_TMUX_BIN ?? "tmux";
  if (hasExecutable(command, ["-V"], executor)) return ["Tmux already installed."];

  const plan = detectTmuxInstallPlan(env, executor);
  if (plan === null) {
    return ["Tmux is not installed.", "Install tmux manually, then run yui doctor."];
  }
  const lines = [
    "Tmux is not installed.",
    `Install with ${plan.manager}:`,
    ...plan.steps.map((step) => `  ${step.command} ${step.args.join(" ")}`)
  ];
  const answer = (await question("Install tmux now? [y/N]: ")).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    return [...lines, "Skipped tmux installation.", "After installing tmux, run yui doctor."];
  }
  for (const step of plan.steps) executor.run(step.command, [...step.args], { inheritStdio: true });
  return hasExecutable(command, ["-V"], executor)
    ? [...lines, "Tmux installed."]
    : [...lines, `Tmux install command completed, but ${command} is still unavailable.`, plan.manualHint];
}

function detectTmuxInstallPlan(
  env: NodeJS.ProcessEnv,
  executor: CommandExecutor
): InstallPlan | null {
  if (process.platform === "darwin" && commandExists("brew", env, executor)) {
    return {
      manager: "Homebrew",
      steps: [{ command: "brew", args: ["install", "tmux"] }],
      manualHint: "brew install tmux"
    };
  }
  if (process.platform !== "linux") return null;
  for (const candidate of [
    { command: "apt-get", args: ["install", "-y", "tmux"], hint: "sudo apt-get install -y tmux" },
    { command: "dnf", args: ["install", "-y", "tmux"], hint: "sudo dnf install -y tmux" },
    { command: "pacman", args: ["-S", "--noconfirm", "tmux"], hint: "sudo pacman -S --noconfirm tmux" },
    { command: "apk", args: ["add", "tmux"], hint: "sudo apk add tmux" }
  ]) {
    if (!commandExists(candidate.command, env, executor)) continue;
    const step = withLinuxPrivilege(candidate.command, candidate.args, env, executor);
    if (step !== null) {
      return { manager: candidate.command, steps: [step], manualHint: candidate.hint };
    }
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

function commandExists(
  command: string,
  env: NodeJS.ProcessEnv,
  executor: CommandExecutor
): boolean {
  if (command.includes("/")) return existsSync(command);
  return (env.PATH ?? "").split(delimiter).filter(Boolean)
    .some((entry) => existsSync(join(entry, command)))
    || hasExecutable(command, ["--version"], executor);
}

function withLinuxPrivilege(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  executor: CommandExecutor
): InstallStep | null {
  if (process.getuid?.() === 0) return { command, args };
  if (!commandExists("sudo", env, executor)) return null;
  return { command: "sudo", args: [command, ...args] };
}
