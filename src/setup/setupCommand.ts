import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

import {
  configuredAgentToDefinition,
  createConfiguredAgent,
  type ConfiguredAgent
} from "../agent/agent.js";
import type { AgentAdapterId } from "../agent/adapterCatalog.js";
import { assertRoleRuntimeMutationAllowed } from "../commands/roleRuntimeGuard.js";
import { resolveTmuxBin } from "../config/yuiConfig.js";
import { usageError } from "../errors/cliError.js";
import {
  createGlobalRole,
  createRoleAgentBinding,
  updateGlobalRole,
  type GlobalRole
} from "../role/role.js";
import { SYSTEM_LEADER_ROLE, SYSTEM_OPERATOR_ROLE } from "../role/systemRoles.js";
import { initializeCompatibleTaskStore } from "../storage/compatibleTaskStore.js";
import {
  ensureYuiHome,
  resolveYuiHome,
  type TaskStore
} from "../storage/taskStore.js";
import type { CommandExecutor } from "../tmux/commandExecutor.js";

export type SetupIo = Readonly<{
  input?: Readable & { isTTY?: boolean };
  output?: Writable & { columns?: number };
  forceInteractive?: boolean;
}>;

type InteractiveSetupIo = SetupIo & Required<Pick<SetupIo, "input" | "output">>;
type SetupQuestion = (prompt: string) => Promise<string>;

type SetupAgentChoice = Readonly<{
  id: string;
  adapterId: AgentAdapterId;
  command: string;
  description: string;
  existing?: ConfiguredAgent;
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
  parseSetupOptions(args);
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
    const store = initializeCompatibleTaskStore(home);
    const tmuxBin = resolveTmuxBin(store.getConfig().tmuxBin);
    assertTmuxAvailable(executor, tmuxBin);
    const choices = availableAgentChoices(store, env);
    if (choices.length === 0) {
      throw usageError(
        "No usable Agent configuration was found. Setup never overwrites an existing Agent id; "
        + "repair it with yui config agent update, add another usable Agent with yui config agent add, "
        + "or install Codex or Claude, then run yui setup again."
      );
    }

    const currentOperator = store.getGlobalRole(SYSTEM_OPERATOR_ROLE);
    const selected = await selectOperatorAgent(
      choices,
      currentOperator,
      store.getConfig().defaultAgent,
      question,
      io
    );
    const agent = selected.existing ?? createConfiguredAgent(
      selected.id,
      selected.adapterId,
      selected.command,
      [],
      [],
      new Date()
    );
    const workspace = resolveWorkspace(
      store.getConfig().defaultWorkspace ?? join(dirname(resolve(home)), "workspace"),
      home
    );
    const roleStatus = saveMinimumConfiguration(
      store,
      agent,
      workspace,
      new Set(choices.map(({ id }) => id))
    );

    return `${[
      "Yui setup complete.",
      `Yui home: ${home}.`,
      `Operator Agent: ${agent.id}.`,
      `Leader Agent: ${roleStatus.leaderAgentId}.`,
      `Default workspace: ${workspace}.`,
      `Operator configuration: ${roleStatus.operator}.`,
      `Leader configuration: ${roleStatus.leader}.`,
      `Tmux: ${tmuxBin}.`,
      "Setup did not configure Review, Worker, Profiles, or shell completion.",
      "Run `yui operator enter` to continue, or `yui config show` to inspect configuration."
    ].join("\n")}\n`;
  } finally {
    readline.close();
  }
}

export function validateSetupInvocation(args: readonly string[], io: SetupIo = {}): void {
  parseSetupOptions(args);
  if (!shouldPrompt(io)) throw setupRequiresInteractiveError();
}

function availableAgentChoices(
  store: TaskStore,
  env: NodeJS.ProcessEnv
): SetupAgentChoice[] {
  const choices = new Map<string, SetupAgentChoice>();
  const configured = store.listConfiguredAgents();
  const configuredIds = new Set(configured.map(({ id }) => id));
  for (const agent of configured) {
    if (!commandOnPath(agent.command, env)) continue;
    choices.set(agent.id, {
      id: agent.id,
      adapterId: agent.adapterId,
      command: agent.command,
      description: "Existing Yui Agent",
      existing: agent
    });
  }
  for (const builtin of BUILTIN_AGENTS) {
    if (configuredIds.has(builtin.id) || !commandOnPath(builtin.command, env)) continue;
    choices.set(builtin.id, builtin);
  }
  return [...choices.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function selectOperatorAgent(
  choices: readonly SetupAgentChoice[],
  currentOperator: GlobalRole | null,
  defaultAgent: string | undefined,
  question: SetupQuestion,
  io: SetupIo
): Promise<SetupAgentChoice> {
  const current = choices.find(({ id }) => id === currentOperator?.activeAgentId);
  if (current !== undefined) return current;
  const configuredDefault = choices.find(({ id }) => id === defaultAgent);
  if (configuredDefault !== undefined) return configuredDefault;
  if (choices.length === 1) return choices[0]!;

  io.output?.write([
    "Available Operator Agents:",
    ...choices.map((choice, index) =>
      `  ${index + 1}. ${choice.id} (${choice.adapterId}) - ${choice.description}`),
    ""
  ].join("\n"));
  const answer = (await question(`Choose Operator Agent [1: ${choices[0]!.id}]: `)).trim();
  if (answer.length === 0) return choices[0]!;
  const numeric = Number(answer);
  const selected = Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= choices.length
    ? choices[numeric - 1]
    : choices.find(({ id }) => id.toLowerCase() === answer.toLowerCase());
  if (selected === undefined) {
    throw usageError("Choose one available Agent by number or name.");
  }
  return selected;
}

function saveMinimumConfiguration(
  store: TaskStore,
  agent: ConfiguredAgent,
  workspace: string,
  usableAgentIds: ReadonlySet<string>
): Readonly<{
  operator: "created" | "preserved" | "updated";
  leader: "created" | "preserved";
  leaderAgentId: string;
}> {
  return store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    const config = tx.getConfig();
    tx.saveConfig({
      ...config,
      defaultAgent: config.defaultAgent ?? agent.id,
      defaultWorkspace: config.defaultWorkspace ?? workspace
    });

    const now = new Date();
    const leader = tx.getGlobalRole(SYSTEM_LEADER_ROLE);
    let leaderStatus: "created" | "preserved" = "preserved";
    let leaderAgentId = leader?.activeAgentId;
    if (leader === null) {
      assertRoleRuntimeMutationAllowed(tx, {
        scope: "global",
        roleName: SYSTEM_LEADER_ROLE
      }, "creation");
      const definition = configuredAgentToDefinition(agent);
      tx.saveGlobalRole(createGlobalRole(
        SYSTEM_LEADER_ROLE,
        [createRoleAgentBinding(definition)],
        agent.id,
        workspace,
        now
      ));
      leaderStatus = "created";
      leaderAgentId = agent.id;
    }
    if (leaderAgentId === undefined) {
      throw usageError(
        "Leader has no active Agent. Repair it with yui config role update leader, then run yui setup again."
      );
    }
    if (!usableAgentIds.has(leaderAgentId)) {
      throw usageError(
        `Leader Agent ${leaderAgentId} is unavailable. Repair it with yui config agent update `
        + "or yui config role update leader, then run yui setup again."
      );
    }

    const operator = tx.getGlobalRole(SYSTEM_OPERATOR_ROLE);
    if (operator !== null && operator.activeAgentId === agent.id) {
      return {
        operator: "preserved",
        leader: leaderStatus,
        leaderAgentId
      };
    }

    const definition = configuredAgentToDefinition(agent);
    const binding = createRoleAgentBinding(definition);
    if (operator === null) {
      assertRoleRuntimeMutationAllowed(tx, {
        scope: "global",
        roleName: SYSTEM_OPERATOR_ROLE
      }, "creation");
      tx.saveGlobalRole(createGlobalRole(
        SYSTEM_OPERATOR_ROLE,
        [binding],
        agent.id,
        workspace,
        now
      ));
      return {
        operator: "created",
        leader: leaderStatus,
        leaderAgentId
      };
    }

    assertRoleRuntimeMutationAllowed(tx, {
      scope: "global",
      roleName: SYSTEM_OPERATOR_ROLE
    }, "desired Agent binding update");
    tx.saveGlobalRole(updateGlobalRole(operator, {
      activeAgentId: agent.id,
      agentBindings: { ...operator.agentBindings, [agent.id]: binding }
    }, now));
    return {
      operator: "updated",
      leader: leaderStatus,
      leaderAgentId
    };
  });
}

function resolveWorkspace(value: string, home: string): string {
  if (!isAbsolute(value)) throw usageError("Default workspace must be an absolute path.");
  const requested = resolve(value);
  assertWorkspaceOutsideHome(requested, resolve(home));
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const workspace = realpathSync(requested);
  const homeRoot = realpathSync(resolve(home));
  assertWorkspaceOutsideHome(workspace, homeRoot);
  return workspace;
}

function assertWorkspaceOutsideHome(workspace: string, homeRoot: string): void {
  const fromHome = relative(homeRoot, workspace);
  if (fromHome === "" || (!fromHome.startsWith("..") && !isAbsolute(fromHome))) {
    throw usageError("Default workspace must be outside YUI_HOME.");
  }
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

function assertTmuxAvailable(executor: CommandExecutor, tmuxBin: string): void {
  try {
    executor.run(tmuxBin, ["-V"], { timeoutMs: 3_000 });
  } catch {
    throw usageError(
      `Tmux is required to run the Operator, but ${tmuxBin} is unavailable. `
      + "Install tmux or set yui config tools set tmux-bin, then run yui setup again."
    );
  }
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

function parseSetupOptions(args: readonly string[]): void {
  if (args.length !== 0) throw usageError("Setup usage: yui setup");
}
