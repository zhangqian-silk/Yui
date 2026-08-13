import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
import {
  selectAgentPermission,
  selectAgentModelAndEffort
} from "../cli/agentConfigurationPicker.js";
import type { SelectionIo } from "../cli/interactiveSelection.js";
import type { CompletionStore } from "../completion/completionInstaller.js";
import { runCompletionWizard } from "../completion/completionWizard.js";
import { usageError } from "../errors/cliError.js";
import {
  defaultRoleAgentConfig,
  resolveAgentAdapter
} from "../executor/agentAdapter.js";
import {
  AgentConfigurationCatalogService
} from "../executor/agentConfigurationCatalog.js";
import type { GlobalRoleSessionSet } from "../executor/agentExecutor.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { resolveTimeZone } from "../output/timePresentation.js";
import {
  createGlobalRole,
  createRoleAgentBinding,
  updateGlobalRole,
  type GlobalRole,
  type RoleProfile,
  type RoleAgentConfig
} from "../role/role.js";
import {
  SYSTEM_LEADER_ROLE,
  SYSTEM_OPERATOR_ROLE,
  SYSTEM_WORKER_ROLE
} from "../role/systemRoles.js";
import {
  DEFAULT_REVIEWER_ROLE,
  type ReviewConfig
} from "../review/reviewConfig.js";
import type { MailboxTarget, WorkMailbox } from "../coordination/workMailbox.js";
import {
  builtinAgentProfileInputs,
  createAgentProfile,
  type AgentProfile
} from "../profile/agentProfile.js";
import { assertRoleRuntimeMutationAllowed } from "../commands/roleRuntimeGuard.js";
import {
  ensureYuiHome,
  resolveYuiHome
} from "../storage/taskStore.js";
import type { YuiConfig } from "../storage/taskStore.js";
import { initializeCompatibleFileTaskStore } from "../storage/compatibleTaskStore.js";
import type { CommandExecutor } from "../tmux/commandExecutor.js";

export type SetupDependency = "tmux";

export type SetupIo = Readonly<{
  input?: Readable & { isTTY?: boolean };
  output?: Writable & { columns?: number };
  forceInteractive?: boolean;
}>;

type InteractiveSetupIo = SetupIo & Required<Pick<SetupIo, "input" | "output">>;
type SetupQuestion = (prompt: string) => Promise<string>;

type SetupStore = Omit<CompletionStore, "transaction" | "getConfig" | "saveConfig"> & Readonly<{
  transaction<T>(execute: (store: SetupStore) => T): T;
  getConfig(): YuiConfig;
  saveConfig(config: YuiConfig): void;
  listConfiguredAgents(): ConfiguredAgent[];
  getConfiguredAgent(id: string): ConfiguredAgent | null;
  saveConfiguredAgent(agent: ConfiguredAgent): void;
  listGlobalRoles(): GlobalRole[];
  getGlobalRole(name: string): GlobalRole | null;
  saveGlobalRole(role: GlobalRole): void;
  saveGlobalRoleWithSessionSet(role: GlobalRole, sessions: GlobalRoleSessionSet | null): void;
  getGlobalRoleSessionSet(name: string): GlobalRoleSessionSet | null;
  getWorkMailbox(target: MailboxTarget): WorkMailbox | null;
  getAgentProfile(id: string): AgentProfile | null;
  saveAgentProfile(profile: AgentProfile): void;
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
    const store = initializeCompatibleFileTaskStore(home);
    const catalogs = new AgentConfigurationCatalogService(home, { environment: env });
    const result = await configureYui(
      store,
      home,
      env,
      question,
      setupSelectionIo(question, io),
      catalogs,
      io
    );
    const lines = [
      "Yui home initialized.",
      `Agents configured: ${result.agentIds.join(", ")}.`,
      `Default Agent: ${result.defaultAgentId}.`,
      `Operator Agent: ${result.operatorAgentId}.`,
      `Leader model: ${result.leaderConfig.model ?? "CLI default"}.`,
      `Leader reasoning effort: ${result.leaderConfig.effort ?? "CLI default"}.`,
      `Leader permission: ${result.leaderConfig.permission.strategy}.`,
      `Operator model: ${result.operatorConfig.model ?? "CLI default"}.`,
      `Operator reasoning effort: ${result.operatorConfig.effort ?? "CLI default"}.`,
      `Operator permission: ${result.operatorConfig.permission.strategy}.`,
      `Worker Agent: ${result.workerAgentId}.`,
      `Worker configuration: ${result.workerReusesLeader
        ? "Reused Leader configuration"
        : "Configured separately"}.`,
      `Worker model: ${result.workerConfig.model ?? "CLI default"}.`,
      `Worker reasoning effort: ${result.workerConfig.effort ?? "CLI default"}.`,
      `Worker permission: ${result.workerConfig.permission.strategy}.`,
      ...(result.reviewerInitialized
        ? [
            `Reviewer Agent: ${result.reviewerAgentId}.`,
            `Reviewer model: ${result.reviewerConfig?.model ?? "CLI default"}.`,
            `Reviewer reasoning effort: ${result.reviewerConfig?.effort ?? "CLI default"}.`,
            `Reviewer permission: ${result.reviewerConfig?.permission.strategy}.`,
            ...(result.reviewPolicy === undefined
              ? ["Review policy: disabled."]
              : [`Review policy: ${result.reviewPolicy.roleName} (${result.reviewPolicy.trigger}).`])
          ]
        : []),
      `Project workspace: ${result.workspace}.`,
      `Time zone: ${resolveTimeZone(store.getConfig().timeZone)}.`
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
  selectionIo: SelectionIo,
  catalogs: AgentConfigurationCatalogService,
  io: SetupIo
): Promise<Readonly<{
  agentIds: readonly string[];
  defaultAgentId: string;
  operatorAgentId: string;
  leaderConfig: RoleAgentConfig;
  operatorConfig: RoleAgentConfig;
  workerAgentId: string;
  workerConfig: RoleAgentConfig;
  workerReusesLeader: boolean;
  reviewerInitialized: boolean;
  reviewerAgentId?: string;
  reviewerConfig?: RoleAgentConfig;
  reviewPolicy?: ReviewConfig;
  workspace: string;
}>> {
  const initialConfig = store.getConfig();
  const freshHome = store.listGlobalRoles().length === 0
    && store.listConfiguredAgents().length === 0
    && initialConfig.defaultAgent === undefined
    && initialConfig.defaultWorkspace === undefined
    && initialConfig.review === undefined;
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
  const prepared = selected.map((choice) => prepareAgent(store, choice, now));
  const configuredIds = new Set(prepared.map(({ id }) => id));
  const config = store.getConfig();
  const defaultFallback = prepared.some(({ id }) => id === config.defaultAgent)
    ? config.defaultAgent as string
    : prepared[0]!.id;

  const defaultAgentId = parseSingleAgentSelection(
    await question(`Choose default Agent [${defaultFallback}]: `),
    prepared,
    defaultFallback
  );
  const currentOperatorAgent = store.getGlobalRole(SYSTEM_OPERATOR_ROLE)?.activeAgentId;
  const operatorFallback = configuredIds.has(currentOperatorAgent ?? "")
    ? currentOperatorAgent as string
    : defaultAgentId;
  const operatorAgentId = parseSingleAgentSelection(
    await question(`Choose Operator Agent [${operatorFallback}]: `),
    prepared,
    operatorFallback
  );
  const existingReviewer = store.getGlobalRole(DEFAULT_REVIEWER_ROLE);
  const reviewerInitialized = freshHome || existingReviewer !== null;
  let reviewerAgentId: string | undefined;
  let reviewerConfig: RoleAgentConfig | undefined;
  if (reviewerInitialized) {
    const reviewerFallback = configuredIds.has(existingReviewer?.activeAgentId ?? "")
      ? existingReviewer!.activeAgentId
      : defaultAgentId;
    reviewerAgentId = parseSingleAgentSelection(
      await question(`Choose Reviewer Agent [${reviewerFallback}]: `),
      prepared,
      reviewerFallback
    );
    const reviewerAgent = prepared.find(({ id }) => id === reviewerAgentId);
    if (reviewerAgent === undefined) {
      throw usageError("Selected Reviewer Agent is no longer available.");
    }
    reviewerConfig = await promptRoleAgentConfig(
      "Reviewer",
      reviewerAgent,
      existingReviewer,
      home,
      selectionIo,
      catalogs,
      true
    );
  }
  const defaultAgent = prepared.find(({ id }) => id === defaultAgentId);
  const operatorAgent = prepared.find(({ id }) => id === operatorAgentId);
  if (defaultAgent === undefined || operatorAgent === undefined) {
    throw usageError("Selected setup Agent is no longer available.");
  }
  const leaderConfig = await promptRoleAgentConfig(
    "Leader",
    defaultAgent,
    store.getGlobalRole(SYSTEM_LEADER_ROLE),
    home,
    selectionIo,
    catalogs
  );
  const operatorConfig = await promptRoleAgentConfig(
    "Operator",
    operatorAgent,
    store.getGlobalRole(SYSTEM_OPERATOR_ROLE),
    home,
    selectionIo,
    catalogs
  );
  const existingWorker = store.getGlobalRole(SYSTEM_WORKER_ROLE);
  const workerModeFallback = workerConfigurationModeFallback(
    existingWorker,
    defaultAgentId,
    leaderConfig
  );
  io.output?.write(
    "\nWorker is the default Agent configuration copied into Task Roles such as "
    + "investigator and implementer. Each Task Role gets its own Session.\n"
  );
  const workerReusesLeader = parseWorkerConfigurationMode(
    await question(
      `Choose Worker configuration (reuse Leader/configure separately) [${
        workerModeFallback === "reuse-leader" ? "reuse Leader" : "configure separately"
      }]: `
    ),
    workerModeFallback
  ) === "reuse-leader";
  let workerAgentId = defaultAgentId;
  let workerConfig = structuredClone(leaderConfig);
  if (!workerReusesLeader) {
    const existingWorkerAgent = existingWorker?.activeAgentId;
    const workerFallback = configuredIds.has(existingWorkerAgent ?? "")
      ? existingWorkerAgent as string
      : defaultAgentId;
    workerAgentId = parseSingleAgentSelection(
      await question(`Choose Worker Agent [${workerFallback}]: `),
      prepared,
      workerFallback
    );
    const workerAgent = prepared.find(({ id }) => id === workerAgentId);
    if (workerAgent === undefined) {
      throw usageError("Selected Worker Agent is no longer available.");
    }
    workerConfig = await promptRoleAgentConfig(
      "Worker",
      workerAgent,
      existingWorker,
      home,
      selectionIo,
      catalogs
    );
  }
  const suggestedWorkspace = config.defaultWorkspace?.trim()
    || join(dirname(resolve(home)), "workspace");
  const workspaceAnswer = (await question(
    `Project workspace for stable checkouts and managed worktrees [${suggestedWorkspace}]: `
  )).trim();
  const workspace = resolveWorkspace(workspaceAnswer || suggestedWorkspace, home);
  if (config.defaultWorkspace !== undefined
    && resolve(config.defaultWorkspace) !== workspace) {
    throw usageError(
      `Project workspace is fixed after setup: ${resolve(config.defaultWorkspace)}.`
    );
  }
  store.transaction((tx) => {
    for (const agent of prepared) tx.saveConfiguredAgent(agent);
    const latestDefaultAgent = requireSetupAgent(tx, defaultAgentId);
    const latestOperatorAgent = requireSetupAgent(tx, operatorAgentId);
    const latestWorkerAgent = requireSetupAgent(tx, workerAgentId);
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
    const workerRole = prepareSystemRole(
      tx,
      SYSTEM_WORKER_ROLE,
      latestWorkerAgent,
      workspace,
      now,
      workerConfig
    );
    const reviewerRole = reviewerInitialized
      && reviewerAgentId !== undefined
      && reviewerConfig !== undefined
      ? prepareSystemRole(
          tx,
          DEFAULT_REVIEWER_ROLE,
          requireSetupAgent(tx, reviewerAgentId),
          workspace,
          now,
          reviewerConfig,
          freshHome ? reviewerRoleProfile() : undefined
        )
      : null;
    const latest = tx.getConfig();
    tx.saveConfig({
      ...latest,
      defaultAgent: defaultAgentId,
      defaultWorkspace: workspace,
      timeZone: resolveTimeZone(latest.timeZone),
      ...(freshHome
        ? { review: { roleName: DEFAULT_REVIEWER_ROLE, trigger: "final" as const } }
        : {})
    });
    if (operatorRole !== null) savePreparedSystemRole(tx, operatorRole, now);
    if (leaderRole !== null) savePreparedSystemRole(tx, leaderRole, now);
    if (workerRole !== null) savePreparedSystemRole(tx, workerRole, now);
    if (reviewerRole !== null) savePreparedSystemRole(tx, reviewerRole, now);
    seedBuiltinProfiles(tx, now);
  });

  return {
    agentIds: prepared.map(({ id }) => id),
    defaultAgentId,
    operatorAgentId,
    leaderConfig,
    operatorConfig,
    workerAgentId,
    workerConfig,
    workerReusesLeader,
    reviewerInitialized,
    ...(reviewerAgentId === undefined ? {} : { reviewerAgentId }),
    ...(reviewerConfig === undefined ? {} : { reviewerConfig }),
    ...(freshHome
      ? { reviewPolicy: { roleName: DEFAULT_REVIEWER_ROLE, trigger: "final" as const } }
      : initialConfig.review === undefined ? {} : { reviewPolicy: initialConfig.review }),
    workspace
  };
}

function reviewerRoleProfile(): RoleProfile {
  const reviewer = builtinAgentProfileInputs().find(({ id }) => id === "reviewer");
  if (reviewer === undefined) return {};
  return {
    ...(reviewer.description === undefined ? {} : { description: reviewer.description }),
    ...(reviewer.instructions === undefined ? {} : { systemPrompt: reviewer.instructions }),
    ...(reviewer.skills === undefined ? {} : { skills: [...reviewer.skills] })
  };
}

type WorkerConfigurationMode = "reuse-leader" | "configure-separately";

function workerConfigurationModeFallback(
  existing: GlobalRole | null,
  leaderAgentId: string,
  leaderConfig: RoleAgentConfig
): WorkerConfigurationMode {
  if (existing === null) return "reuse-leader";
  return existing.activeAgentId === leaderAgentId
    && isDeepStrictEqual(existing.agentBindings[leaderAgentId]?.config, leaderConfig)
    ? "reuse-leader"
    : "configure-separately";
}

function parseWorkerConfigurationMode(
  answer: string,
  fallback: WorkerConfigurationMode
): WorkerConfigurationMode {
  const value = answer.trim().toLowerCase();
  if (value.length === 0) return fallback;
  if (["1", "reuse", "reuse leader", "leader"].includes(value)) return "reuse-leader";
  if (["2", "configure", "configure separately", "separate"].includes(value)) {
    return "configure-separately";
  }
  throw usageError("Choose reuse Leader or configure separately for Worker.");
}

function savePreparedSystemRole(
  store: SetupStore,
  role: GlobalRole,
  now: Date
): void {
  const sessions = store.getGlobalRoleSessionSet(role.name);
  const activeSession = sessions?.sessions[sessions.activeAgentId];
  if (
    sessions === null
    || sessions.activeAgentId === role.activeAgentId
    || (activeSession !== undefined && activeSession.status !== "stopped")
  ) {
    store.saveGlobalRole(role);
    return;
  }
  store.saveGlobalRoleWithSessionSet(role, {
    ...sessions,
    activeAgentId: role.activeAgentId,
    updatedAt: now.toISOString()
  });
}

function seedBuiltinProfiles(
  store: SetupStore,
  now: Date
): void {
  for (const desired of builtinAgentProfileInputs()) {
    const existing = store.getAgentProfile(desired.id);
    if (existing === null) store.saveAgentProfile(createAgentProfile(desired, now));
  }
}

async function promptRoleAgentConfig(
  label: string,
  agent: ConfiguredAgent,
  existingRole: GlobalRole | null,
  cwd: string,
  io: SelectionIo,
  catalogs: AgentConfigurationCatalogService,
  selectPermission = false
): Promise<RoleAgentConfig> {
  const existing = existingRole?.activeAgentId === agent.id
    ? existingRole.agentBindings[agent.id]?.config
    : undefined;
  io.write(`\n${label} Agent configuration: ${agent.id}\n`);
  const resolved = await catalogs.resolve({
      agent,
      cwd,
      ...(existing === undefined ? {} : { config: existing })
    });
  const selection = await selectAgentModelAndEffort(
    resolved,
    io,
    {
      currentModel: existing?.model,
      currentEffort: existing?.effort
    }
  );
  if (selection.kind === "cancelled") {
    throw usageError(`${label} Agent configuration was cancelled.`);
  }
  const candidate = structuredClone(
    existing ?? defaultRoleAgentConfig(agent.adapterId)
  ) as unknown as Record<string, unknown>;
  if (selection.model === undefined) delete candidate.model;
  else candidate.model = selection.model;
  if (selection.effort === undefined) delete candidate.effort;
  else candidate.effort = selection.effort;
  if (selectPermission) {
    const permission = await selectAgentPermission(
      resolved,
      io,
      candidate.permission as RoleAgentConfig["permission"]
    );
    if (permission.kind === "cancelled") {
      throw usageError(`${label} permission configuration was cancelled.`);
    }
    candidate.permission = permission.permission;
  }
  try {
    return resolveAgentAdapter(agent.adapterId).canonicalizeConfig(
      candidate as RoleAgentConfig
    );
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
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

function setupSelectionIo(
  question: SetupQuestion,
  io: InteractiveSetupIo
): SelectionIo {
  return {
    interactive: true,
    json: false,
    width: tableWidth(io),
    write: (value) => { io.output.write(value); },
    question
  };
}

function prepareAgent(
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
  config: RoleAgentConfig,
  profile?: RoleProfile
): GlobalRole | null {
  const existing = store.getGlobalRole(name);
  if (existing !== null) {
    const definition = configuredAgentToDefinition(agent);
    const binding = createRoleAgentBinding(definition, config);
    if (name === "operator" && !Object.hasOwn(existing.agentBindings, agent.id)) {
      const sameAdapter = Object.values(existing.agentBindings).find(
        (candidate) => candidate.adapterId === agent.adapterId
      );
      if (sameAdapter !== undefined) {
        throw usageError(
          `${name} already has a ${agent.adapterId} Agent: ${sameAdapter.agentId}. `
          + "Update that Agent's configuration, or activate another adapter and "
          + "unbind it before selecting this Agent."
        );
      }
    }
    if (
      existing.activeAgentId === agent.id
      && existing.workspace === workspace
      && isDeepStrictEqual(existing.agentBindings[agent.id], binding)
    ) {
      return null;
    }
    assertRoleRuntimeMutationAllowed(store, {
      scope: "global",
      roleName: name
    }, "desired launch configuration update");
    return updateGlobalRole(existing, {
      activeAgentId: agent.id,
      workspace,
      agentBindings: { ...existing.agentBindings, [agent.id]: binding },
      ...(profile === undefined ? {} : profile)
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
    now,
    profile
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
  agents: readonly Pick<ConfiguredAgent, "id">[],
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

function resolveWorkspace(value: string, home: string): string {
  if (!isAbsolute(value)) throw usageError("Project workspace must be an absolute path.");
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
    throw usageError("Project workspace must be outside YUI_HOME.");
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
