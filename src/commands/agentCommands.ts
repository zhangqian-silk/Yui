import { agentNotFound, usageError } from "../errors/cliError.js";
import { createConfiguredAgent } from "../agent/agent.js";
import { supportedAgentAdapterIds } from "../agent/adapterCatalog.js";
import type { AgentDefinition, EnvironmentBinding } from "../agent/agent.js";
import type { ConfiguredAgentPatch, TaskReader, TaskStore } from "../storage/taskStore.js";
import { presentAgentDefinition } from "../output/roleAgentPresentation.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import {
  type ProbeExecutableResolutionContext,
  enrollAgentCapabilityProbePin,
  findReservedAgentArgument,
  findAgentAdapter
} from "../executor/agentAdapter.js";
import {
  inspectAgentList,
  inspectAgentShow,
  renderAgentList,
  renderAgentShow
} from "./agentInspection.js";

export function runAgentCommand(
  args: string[],
  store: TaskStore,
  processEnvironment: NodeJS.ProcessEnv = process.env,
  probeResolution?: ProbeExecutableResolutionContext
): string {
  const [command, ...rest] = args;

  switch (command) {
    case "add":
      return addAgentCommand(rest, store, processEnvironment, probeResolution);
    case "list":
      return listAgentCommand(store);
    case "show":
      return showAgentCommand(rest, store);
    case "update":
      return updateAgentCommand(rest, store, processEnvironment, probeResolution);
    case "remove":
      return removeAgentCommand(rest, store);
    default:
      throw usageError(command === undefined ? "Agent command is required." : `Unknown command: agent ${command}`);
  }
}

export function runAgentReadCommand(args: string[], store: TaskReader): string {
  if (args[0] !== "list" && args[0] !== "show") {
    throw usageError(args[0] === undefined ? "Agent command is required." : `Unknown command: agent ${args[0]}`);
  }
  return runAgentCommand(args, store as TaskStore);
}

function addAgentCommand(
  args: string[],
  store: TaskStore,
  processEnvironment: NodeJS.ProcessEnv,
  probeResolution?: ProbeExecutableResolutionContext
): string {
  const [id, ...rest] = args;

  if (id === undefined || id.trim().length === 0) {
    throw usageError("Agent id is required.");
  }

  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw usageError("Agent id may only contain letters, numbers, hyphens, and underscores.");
  }

  const parsed = parseAgentAddArguments(rest, id);
  const command = parsed.command.trim();
  const adapterId = parsed.adapterId.trim();

  if (command.length === 0) {
    throw usageError("--command is required.");
  }

  const baseArgs = parsed.baseArgs;
  assertUnreservedBaseArgs(adapterId, baseArgs);
  const probePin = enrollAgentCapabilityProbePin(
    { adapterId, command },
    processEnvironment,
    probeResolution
  );
  if (isCanonicalProbeAgent(adapterId, command) && probePin === undefined) {
    throw usageError("No trusted executable is available to enroll this Agent capability probe pin.");
  }
  const agent = createConfiguredAgent(
    id,
    adapterId,
    command,
    baseArgs,
    parsed.environment.map(parseEnv),
    new Date(),
    probePin
  );
  const created = store.createConfiguredAgentIfAbsent(agent);
  if (created === null) {
    throw usageError(`Agent already exists: ${agent.id}. Use taskmux agent update to change it.`);
  }

  return renderAgent(`Added agent ${created.id}`, {
    ...created,
    source: "custom"
  });
}

function updateAgentCommand(
  args: string[],
  store: TaskStore,
  processEnvironment: NodeJS.ProcessEnv,
  probeResolution?: ProbeExecutableResolutionContext
): string {
  const [id, ...rest] = args;
  if (id === undefined || id.trim().length === 0) {
    throw usageError("Agent id is required.");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw usageError("Agent id may only contain letters, numbers, hyphens, and underscores.");
  }
  const parsed = parseAgentUpdateArguments(rest);
  const { refreshProbe, ...patch } = parsed;
  const existing = store.getConfiguredAgent(id);
  if (existing === null) throw agentNotFound(id);
  if (patch.adapterId !== undefined) {
    assertUnreservedBaseArgs(patch.adapterId, patch.baseArgs ?? existing.baseArgs);
  }
  const adapterId = patch.adapterId ?? existing.adapterId;
  const command = patch.command ?? existing.command;
  const commandChanged = patch.command !== undefined && patch.command !== existing.command;
  const adapterChanged = patch.adapterId !== undefined && patch.adapterId !== existing.adapterId;
  const canonicalProbeAgent = isCanonicalProbeAgent(adapterId, command);
  if (refreshProbe && !canonicalProbeAgent) {
    throw usageError("Only canonical Codex or Claude Agents support capability probe pin refresh.");
  }
  if (refreshProbe || commandChanged || (adapterChanged && canonicalProbeAgent)) {
    const pin = enrollAgentCapabilityProbePin(
      { adapterId, command },
      processEnvironment,
      probeResolution
    );
    if (canonicalProbeAgent && pin === undefined) {
      throw usageError("No trusted executable is available to enroll or refresh this Agent capability probe pin.");
    }
    patch.probePin = pin ?? null;
  } else if (adapterChanged) {
    patch.probePin = null;
  }
  const result = store.updateConfiguredAgent(id, patch, new Date());
  if (result === null) throw agentNotFound(id);
  if (result.status === "unchanged") return `Agent ${id} unchanged\n`;
  return renderAgent(`Updated agent ${id}`, { ...result.agent, source: "custom" });
}

function isCanonicalProbeAgent(adapterId: string, command: string): boolean {
  return (adapterId === "codex" || adapterId === "claude") && command === adapterId;
}

function assertUnreservedBaseArgs(adapterId: string, args: string[]): void {
  const adapter = findAgentAdapter(adapterId);
  if (adapter === null) {
    throw usageError(`Agent adapter is not supported: ${adapterId}. Supported adapters: ${supportedAgentAdapterIds().join(", ")}.`);
  }
  for (const argument of args) {
    const token = findReservedAgentArgument(adapter, argument);
    if (token !== null) {
      throw usageError(`Agent base argument is reserved by adapter ${adapterId}: ${token}.`);
    }
  }
}

function listAgentCommand(store: TaskStore): string {
  return renderAgentList(inspectAgentList(store));
}

function showAgentCommand(args: string[], store: TaskStore): string {
  const [id, ...rest] = args;

  if (id === undefined || id.trim().length === 0) {
    throw usageError("Agent id is required.");
  }
  if (rest.length > 0) {
    throw usageError(`Unexpected agent show argument: ${rest[0]}`);
  }

  const { agent, snapshot } = inspectAgentShow(id, store);
  return renderAgentShow(agent, snapshot);
}

function removeAgentCommand(args: string[], store: TaskStore): string {
  const [id] = args;

  if (id === undefined || id.trim().length === 0) {
    throw usageError("Agent id is required.");
  }

  if (!store.removeConfiguredAgent(id)) {
    throw agentNotFound(id);
  }

  return `Removed agent ${id}\n`;
}

function renderAgent(title: string, agent: AgentDefinition): string {
  const presented = presentAgentDefinition(agent);
  return [
    title,
    `Source: ${presented.source}`,
    `Adapter: ${presented.adapterId}`,
    `Executable: ${presented.executable}`,
    `Arguments: ${presented.arguments}`,
    `Environment bindings: ${presented.environment.length}`,
    ...(presented.environment.length === 0 ? [] : [renderTable(
      "Environment",
      [
        { header: "Key", minWidth: 3, maxWidth: 32 },
        { header: "Source", minWidth: 6, maxWidth: 10 },
        { header: "Required", minWidth: 8, maxWidth: 8 },
        { header: "Value", minWidth: 8, maxWidth: 8 }
      ],
      presented.environment.map((binding) => [
        binding.key,
        binding.source,
        binding.required ? "required" : "optional",
        binding.value
      ]),
      defaultTableWidth()
    )])
  ].join("\n").concat("\n");
}

function parseAgentAddArguments(args: string[], defaultAdapterId: string): {
  adapterId: string;
  command: string;
  baseArgs: string[];
  environment: string[];
} {
  const specs = new Map([
    ["--adapter", { allowOptionLikeValue: false, repeatable: false }],
    ["--command", { allowOptionLikeValue: false, repeatable: false }],
    ["--arg", { allowOptionLikeValue: true, repeatable: true }],
    ["--env", { allowOptionLikeValue: false, repeatable: true }]
  ]);
  const seen = new Set<string>();
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw usageError(`Unexpected argument: ${arg}`);
    }
    const spec = specs.get(arg);
    if (spec === undefined) {
      throw usageError(`Unsupported option: ${arg}`);
    }
    if (!spec.repeatable && seen.has(arg)) {
      throw usageError(`Option may only be specified once: ${arg}`);
    }
    const value = args[index + 1];
    if (value === undefined || (!spec.allowOptionLikeValue && value.startsWith("--"))) {
      throw usageError(`${arg} is required.`);
    }
    seen.add(arg);
    values.set(arg, [...(values.get(arg) ?? []), value]);
    index += 1;
  }
  const adapterId = values.get("--adapter")?.[0] ?? (
    supportedAgentAdapterIds().includes(defaultAdapterId) ? defaultAdapterId : undefined
  );
  const command = values.get("--command")?.[0];
  if (adapterId === undefined) throw usageError("--adapter is required.");
  if (command === undefined) throw usageError("--command is required.");
  return {
    adapterId,
    command,
    baseArgs: [...(values.get("--arg") ?? [])],
    environment: [...(values.get("--env") ?? [])]
  };
}

function parseAgentUpdateArguments(args: string[]): ConfiguredAgentPatch & { refreshProbe: boolean } {
  const valueSpecs = new Map([
    ["--adapter", { allowOptionLikeValue: false, repeatable: false }],
    ["--command", { allowOptionLikeValue: false, repeatable: false }],
    ["--arg", { allowOptionLikeValue: true, repeatable: true }],
    ["--env", { allowOptionLikeValue: false, repeatable: true }]
  ]);
  const flags = new Set(["--clear-args", "--clear-env", "--refresh-probe"]);
  const seen = new Set<string>();
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (flags.has(arg)) {
      if (seen.has(arg)) throw usageError(`Option may only be specified once: ${arg}`);
      seen.add(arg);
      continue;
    }
    if (!arg.startsWith("--")) throw usageError(`Unexpected argument: ${arg}`);
    const spec = valueSpecs.get(arg);
    if (spec === undefined) throw usageError(`Unsupported option: ${arg}`);
    if (!spec.repeatable && seen.has(arg)) {
      throw usageError(`Option may only be specified once: ${arg}`);
    }
    const value = args[index + 1];
    if (value === undefined || (!spec.allowOptionLikeValue && value.startsWith("--"))) {
      throw usageError(`${arg} is required.`);
    }
    seen.add(arg);
    values.set(arg, [...(values.get(arg) ?? []), value]);
    index += 1;
  }
  if (seen.size === 0) throw usageError("Agent update requires at least one operational option.");
  if (seen.has("--arg") && seen.has("--clear-args")) {
    throw usageError("--arg and --clear-args cannot be used together.");
  }
  if (seen.has("--env") && seen.has("--clear-env")) {
    throw usageError("--env and --clear-env cannot be used together.");
  }
  const adapterId = values.get("--adapter")?.[0]?.trim();
  const command = values.get("--command")?.[0]?.trim();
  if (adapterId !== undefined && adapterId.length === 0) throw usageError("--adapter is required.");
  if (command !== undefined && command.length === 0) throw usageError("--command is required.");
  return {
    ...(adapterId === undefined ? {} : { adapterId }),
    ...(command === undefined ? {} : { command }),
    ...(seen.has("--arg")
      ? { baseArgs: [...(values.get("--arg") ?? [])] }
      : seen.has("--clear-args") ? { baseArgs: [] } : {}),
    ...(seen.has("--env")
      ? { environment: (values.get("--env") ?? []).map(parseEnv) }
      : seen.has("--clear-env") ? { environment: [] } : {}),
    refreshProbe: seen.has("--refresh-probe")
  };
}

function parseEnv(value: string): EnvironmentBinding {
  const separator = value.indexOf("=");

  if (separator <= 0) {
    throw usageError("--env must use TARGET=PROCESS_NAME.");
  }
  return {
    target: value.slice(0, separator),
    source: "process",
    sourceName: value.slice(separator + 1),
    required: true
  };
}
