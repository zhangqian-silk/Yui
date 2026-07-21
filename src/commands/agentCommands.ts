import { agentNotFound, usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import type { AgentAdapterId } from "../agent/adapterCatalog.js";
import {
  createConfiguredAgent,
  type ConfiguredAgent as ConfiguredAgentRecord,
  type EnvironmentBinding
} from "../agent/agent.js";

export type { ConfiguredAgentRecord, EnvironmentBinding };

export type ConfiguredAgentPatch = Readonly<{
  adapterId?: AgentAdapterId;
  command?: string;
  baseArgs?: readonly string[];
  environment?: readonly EnvironmentBinding[];
}>;

export type AgentCommandStore = Readonly<{
  createConfiguredAgentIfAbsent(agent: ConfiguredAgentRecord): ConfiguredAgentRecord | null;
  updateConfiguredAgent(
    id: string,
    patch: ConfiguredAgentPatch,
    now: Date
  ): Readonly<{ status: "updated" | "unchanged"; agent: ConfiguredAgentRecord }> | null;
  listConfiguredAgents(): ConfiguredAgentRecord[];
  getConfiguredAgent(id: string): ConfiguredAgentRecord | null;
  removeConfiguredAgent(id: string): boolean;
}>;

const SUPPORTED_ADAPTERS = Object.freeze(["codex", "claude"] as const);

export function runAgentCommand(args: string[], store: AgentCommandStore): string {
  const [command, ...rest] = args;
  switch (command) {
    case "add": return addAgent(rest, store);
    case "list": return listAgents(rest, store);
    case "show": return showAgent(rest, store);
    case "update": return updateAgent(rest, store);
    case "remove": return removeAgent(rest, store);
    default:
      throw usageError(command === undefined
        ? "Agent command is required."
        : `Unknown command: agent ${command}`);
  }
}

function addAgent(args: string[], store: AgentCommandStore): string {
  const [rawId, ...tail] = args;
  const id = agentId(rawId);
  const parsed = parseAgentOptions(tail, "add");
  const adapterId = parsed.one("--adapter") ?? (
    SUPPORTED_ADAPTERS.includes(id as (typeof SUPPORTED_ADAPTERS)[number]) ? id : undefined
  );
  if (adapterId === undefined) throw usageError("--adapter is required.");
  assertAdapter(adapterId);
  const command = parsed.one("--command")?.trim();
  if (command === undefined || command.length === 0) throw usageError("--command is required.");
  let agent: ConfiguredAgentRecord;
  try {
    agent = createConfiguredAgent(
      id,
      adapterId,
      command,
      parsed.many("--arg"),
      parsed.many("--env").map(parseEnvironmentBinding),
      new Date()
    );
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
  const created = store.createConfiguredAgentIfAbsent(agent);
  if (created === null) {
    throw usageError(`Agent already exists: ${id}. Use yui agent update to change it.`);
  }
  return renderAgent(`Added agent ${id}`, created);
}

function listAgents(args: string[], store: AgentCommandStore): string {
  assertNoArguments(args, "Agent list usage: yui agent list");
  const agents = store.listConfiguredAgents();
  if (agents.length === 0) return "No agents configured.\n";
  return `${renderTable(
    "Agents",
    [
      { header: "Agent", minWidth: 5, maxWidth: 24 },
      { header: "Adapter", minWidth: 7, maxWidth: 12 },
      { header: "Command", minWidth: 7, maxWidth: 48 },
      { header: "Environment", minWidth: 11, maxWidth: 32 }
    ],
    agents.map((agent) => [
      agent.id,
      agent.adapterId,
      [agent.command, ...agent.baseArgs].join(" "),
      agent.environment.map((binding) => `${binding.target}<-${binding.sourceName}`).join(", ")
    ]),
    defaultTableWidth()
  )}\n`;
}

function showAgent(args: string[], store: AgentCommandStore): string {
  const [rawId, ...rest] = args;
  const id = agentId(rawId);
  assertNoArguments(rest, "Agent show usage: yui agent show <agent-id>");
  const agent = store.getConfiguredAgent(id);
  if (agent === null) throw agentNotFound(id);
  return renderAgent(`Agent: ${id}`, agent);
}

function updateAgent(args: string[], store: AgentCommandStore): string {
  const [rawId, ...tail] = args;
  const id = agentId(rawId);
  const parsed = parseAgentOptions(tail, "update");
  if (parsed.seen.size === 0) {
    throw usageError("Agent update requires at least one operational option.");
  }
  if (parsed.has("--arg") && parsed.has("--clear-args")) {
    throw usageError("--arg and --clear-args cannot be used together.");
  }
  if (parsed.has("--env") && parsed.has("--clear-env")) {
    throw usageError("--env and --clear-env cannot be used together.");
  }
  const adapterId = parsed.one("--adapter")?.trim();
  if (adapterId !== undefined) assertAdapter(adapterId);
  const command = parsed.one("--command")?.trim();
  if (command !== undefined && command.length === 0) throw usageError("--command is required.");
  const patch: ConfiguredAgentPatch = {
    ...(adapterId === undefined ? {} : { adapterId }),
    ...(command === undefined ? {} : { command }),
    ...(parsed.has("--arg")
      ? { baseArgs: parsed.many("--arg") }
      : parsed.has("--clear-args") ? { baseArgs: [] } : {}),
    ...(parsed.has("--env")
      ? { environment: parsed.many("--env").map(parseEnvironmentBinding) }
      : parsed.has("--clear-env") ? { environment: [] } : {})
  };
  const result = store.updateConfiguredAgent(id, patch, new Date());
  if (result === null) throw agentNotFound(id);
  return result.status === "unchanged"
    ? `Agent ${id} unchanged\n`
    : renderAgent(`Updated agent ${id}`, result.agent);
}

function removeAgent(args: string[], store: AgentCommandStore): string {
  const [rawId, ...rest] = args;
  const id = agentId(rawId);
  assertNoArguments(rest, "Agent remove usage: yui agent remove <agent-id>");
  if (!store.removeConfiguredAgent(id)) throw agentNotFound(id);
  return `Removed agent ${id}\n`;
}

type ParsedOptions = Readonly<{
  seen: ReadonlySet<string>;
  has(option: string): boolean;
  one(option: string): string | undefined;
  many(option: string): string[];
}>;

function parseAgentOptions(args: string[], mode: "add" | "update"): ParsedOptions {
  const valueOptions = new Map([
    ["--adapter", { repeatable: false, allowOptionLikeValue: false }],
    ["--command", { repeatable: false, allowOptionLikeValue: false }],
    ["--arg", { repeatable: true, allowOptionLikeValue: true }],
    ["--env", { repeatable: true, allowOptionLikeValue: false }]
  ]);
  const flags = mode === "update" ? new Set(["--clear-args", "--clear-env"]) : new Set<string>();
  const seen = new Set<string>();
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (flags.has(option)) {
      if (seen.has(option)) throw usageError(`Option may only be specified once: ${option}`);
      seen.add(option);
      continue;
    }
    const spec = valueOptions.get(option);
    if (spec === undefined) {
      throw usageError(option.startsWith("--")
        ? `Unsupported option: ${option}`
        : `Unexpected argument: ${option}`);
    }
    if (!spec.repeatable && seen.has(option)) {
      throw usageError(`Option may only be specified once: ${option}`);
    }
    const value = args[index + 1];
    if (value === undefined || (!spec.allowOptionLikeValue && value.startsWith("--"))) {
      throw usageError(`${option} is required.`);
    }
    seen.add(option);
    values.set(option, [...(values.get(option) ?? []), value]);
    index += 1;
  }
  return {
    seen,
    has: (option) => seen.has(option),
    one: (option) => values.get(option)?.[0],
    many: (option) => [...(values.get(option) ?? [])]
  };
}

function parseEnvironmentBinding(value: string): EnvironmentBinding {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw usageError("--env must use TARGET=PROCESS_NAME.");
  }
  const target = value.slice(0, separator).trim();
  const sourceName = value.slice(separator + 1).trim();
  if (!environmentName(target) || !environmentName(sourceName)) {
    throw usageError("--env must use valid environment names: TARGET=PROCESS_NAME.");
  }
  return { target, source: "process", sourceName, required: true };
}

function environmentName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function agentId(value: string | undefined): string {
  if (value === undefined || !/^[A-Za-z0-9_-]+$/.test(value.trim())) {
    throw usageError(value === undefined || value.trim().length === 0
      ? "Agent id is required."
      : "Agent id may only contain letters, numbers, hyphens, and underscores.");
  }
  return value.trim();
}

function assertAdapter(value: string): asserts value is AgentAdapterId {
  if (!SUPPORTED_ADAPTERS.includes(value as (typeof SUPPORTED_ADAPTERS)[number])) {
    throw usageError(`Agent adapter is not supported: ${value}. Supported adapters: ${SUPPORTED_ADAPTERS.join(", ")}.`);
  }
}

function assertNoArguments(args: string[], message: string): void {
  if (args.length > 0) throw usageError(`${message}. Unexpected argument: ${args[0]}`);
}

function renderAgent(title: string, agent: ConfiguredAgentRecord): string {
  return [
    title,
    `Adapter: ${agent.adapterId}`,
    `Executable: ${agent.command}`,
    `Arguments: ${agent.baseArgs.join(" ")}`,
    `Environment bindings: ${agent.environment.length}`,
    ...agent.environment.map((binding) =>
      `  ${binding.target} <- process:${binding.sourceName} (${binding.required ? "required" : "optional"})`)
  ].join("\n").concat("\n");
}
