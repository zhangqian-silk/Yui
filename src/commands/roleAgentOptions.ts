import type { AgentDefinition } from "../agent/agent.js";
import {
  ROLE_AGENT_INHERITABLE_FIELDS,
  ROLE_AGENT_INHERIT_OPTION,
  ROLE_AGENT_OPTION_SPECS,
  ROLE_AGENT_SCRIPTED_OPTIONS,
  ROLE_INHERITABLE_FIELDS,
  roleAgentOptionSpecsForAdapter
} from "../cli/roleOptionCatalog.js";
import type { FirstClassRoleAgentAdapterId } from "../cli/roleOptionCatalog.js";
import { usageError } from "../errors/cliError.js";
import {
  inspectAgentCapabilities,
  isUnprobedCustomAgent,
  resolveAgentAdapter,
  type CapabilityField,
  type CapabilitySnapshot
} from "../executor/agentAdapter.js";
import { createRoleAgentBinding } from "../role/role.js";
import type { RoleAgentBinding, RoleAgentConfig } from "../role/role.js";

export type CommandValueOptionSpec = {
  option: string;
  repeatable?: boolean;
  allowOptionLikeValue?: boolean;
};

export type ParsedRoleCommandOptions = {
  value(name: string): string | undefined;
  values(name: string): string[];
  has(name: string): boolean;
  inherits(fieldKey: string): boolean;
  hasStructuredChanges: boolean;
  createBinding(agent: AgentDefinition, workspace: string, existing?: RoleAgentBinding): RoleAgentBinding;
};

type ParsedStructuredSelection = {
  fieldKey: string;
  option: string;
  values: string[];
};

/**
 * Parse the complete option tail for a Role command before any persistence.
 * The parser owns arity, repeatability, unknown-option and positional checks;
 * callers provide only their non-Agent options.
 */
export function parseRoleCommandOptions(
  args: string[],
  commandOptions: readonly CommandValueOptionSpec[],
  settings: { allowStructured?: boolean; profileInheritableFields?: readonly string[] } = {}
): ParsedRoleCommandOptions {
  const baseSpecs = new Map(commandOptions.map((spec) => [spec.option, spec]));
  const allowStructured = settings.allowStructured !== false;
  const structuredSpecs = new Map<string, (typeof ROLE_AGENT_OPTION_SPECS)[number]>(
    (allowStructured ? ROLE_AGENT_OPTION_SPECS : []).map((spec) => [spec.option, spec])
  );
  const values = new Map<string, string[]>();

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!option.startsWith("--")) {
      throw usageError(`Unexpected argument: ${option}`);
    }

    const structured = structuredSpecs.get(option);
    const base = baseSpecs.get(option);
    const isInherit = option === ROLE_AGENT_INHERIT_OPTION &&
      (allowStructured || (settings.profileInheritableFields?.length ?? 0) > 0);
    if (structured === undefined && base === undefined && !isInherit) {
      throw usageError(`Unsupported option: ${option}`);
    }

    const repeatable = structured?.repeatable === true || base?.repeatable === true || isInherit;
    if (!repeatable && values.has(option)) {
      throw usageError(`Option may only be specified once: ${option}`);
    }

    const candidate = args[index + 1];
    const allowOptionLikeValue = structured?.allowOptionLikeValue === true || base?.allowOptionLikeValue === true;
    if (candidate === undefined || (!allowOptionLikeValue && candidate.startsWith("--"))) {
      throw usageError(`${option} is required.`);
    }

    if (candidate.trim().length === 0) {
      throw usageError(`${option} is required.`);
    }
    values.set(option, [...(values.get(option) ?? []), candidate]);
    index += 1;
  }

  const inherit = values.get(ROLE_AGENT_INHERIT_OPTION) ?? [];
  for (const fieldKey of inherit) {
    if (!ROLE_INHERITABLE_FIELDS.includes(fieldKey) ||
      (!ROLE_AGENT_INHERITABLE_FIELDS.includes(fieldKey) &&
        !settings.profileInheritableFields?.includes(fieldKey))) {
      throw usageError(`Role Agent field cannot be inherited: ${fieldKey}.`);
    }
    const conflicting = ROLE_AGENT_OPTION_SPECS.find((spec) => spec.fieldKey === fieldKey && values.has(spec.option));
    if (conflicting !== undefined) {
      throw usageError(`Role Agent field cannot be set and inherited together: ${fieldKey}.`);
    }
  }

  const selections = ROLE_AGENT_OPTION_SPECS.flatMap((spec) => {
    const selected = values.get(spec.option);
    return selected === undefined ? [] : [{ fieldKey: spec.fieldKey, option: spec.option, values: selected }];
  });
  const agentInherit = inherit.filter((fieldKey) => ROLE_AGENT_INHERITABLE_FIELDS.includes(fieldKey));
  const hasStructuredChanges = selections.length > 0 || agentInherit.length > 0;

  return {
    value: (name) => values.get(name)?.[0],
    values: (name) => [...(values.get(name) ?? [])],
    has: (name) => values.has(name),
    inherits: (fieldKey) => inherit.includes(fieldKey),
    hasStructuredChanges,
    createBinding: (agent, workspace, existing) => createConfiguredRoleAgentBinding(
      agent,
      workspace,
      selections,
      agentInherit,
      existing
    )
  };
}

export { ROLE_AGENT_SCRIPTED_OPTIONS };

function createConfiguredRoleAgentBinding(
  agent: AgentDefinition,
  workspace: string,
  selections: ParsedStructuredSelection[],
  inheritedFields: string[],
  existing?: RoleAgentBinding
): RoleAgentBinding {
  let adapter;
  try {
    adapter = resolveAgentAdapter(agent.adapterId);
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }

  const adapterSpecs = roleAgentOptionSpecsForAdapter(agent.adapterId as FirstClassRoleAgentAdapterId);
  const adapterFields = new Set(adapterSpecs.map((spec) => spec.fieldKey));
  for (const selection of selections) {
    if (!adapterFields.has(selection.fieldKey)) {
      throw usageError(`Role option ${selection.option} is not available for adapter ${agent.adapterId}.`);
    }
  }
  for (const fieldKey of inheritedFields) {
    if (!adapterFields.has(fieldKey)) {
      throw usageError(`Role Agent field ${fieldKey} is not available for adapter ${agent.adapterId}.`);
    }
  }

  const config = cloneConfig(existing?.config ?? { adapterId: agent.adapterId } as RoleAgentConfig);
  for (const fieldKey of inheritedFields) {
    deleteConfigValue(config, fieldKey);
  }

  if (selections.length === 0 && inheritedFields.length === 0) {
    return existing ?? createRoleAgentBinding(agent, config);
  }

  if (existing !== undefined && selections.length === 0) {
    if (!requiresLiveEnumValidation(config)) {
      return replayInheritedBinding(adapter, agent, config, workspace);
    }
    const snapshot = inspectAgentCapabilities(agent);
    if (snapshot.installation.status !== "installed") {
      return replayInheritedBinding(adapter, agent, config, workspace);
    }
    try {
      adapter.validateConfig({ agent, config, workspace, snapshot });
    } catch (error) {
      throw usageError(error instanceof Error ? error.message : String(error));
    }
    return createRoleAgentBinding(agent, config);
  }

  const snapshot = inspectAgentCapabilities(agent);
  const validationMode = isUnprobedCustomAgent(agent, snapshot) ? "unprobed" : "configure";
  if (snapshot.installation.status !== "installed" && validationMode !== "unprobed") {
    throw usageError(`Structured Role configuration requires an installed supported Agent CLI: ${agent.id}.`);
  }
  for (const selection of selections) {
    const spec = adapterSpecs.find((candidate) => candidate.fieldKey === selection.fieldKey);
    if (spec === undefined) {
      throw usageError(`Role option ${selection.option} is not available for adapter ${agent.adapterId}.`);
    }
    const field = selection.fieldKey === "advanced.rawArgs"
      ? undefined
      : requireAvailableField(snapshot, selection.fieldKey, selection.option, agent.adapterId);
    const normalized = selection.values.map((value) => normalizeSelectedValue(value, field, spec.staticValues));
    if (spec.repeatable && normalized.some((value) => typeof value !== "string")) {
      throw usageError(`Role option ${selection.option} does not accept boolean list values.`);
    }
    setConfigValue(
      config,
      selection.fieldKey,
      spec.repeatable ? normalized as string[] : normalized[0]
    );
  }

  try {
    adapter.validateConfig({ agent, config, workspace, snapshot, validationMode });
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
  return createRoleAgentBinding(agent, config);
}

function replayInheritedBinding(
  adapter: ReturnType<typeof resolveAgentAdapter>,
  agent: AgentDefinition,
  config: RoleAgentConfig,
  workspace: string
): RoleAgentBinding {
  const snapshot = adapter.unavailableCapabilities(
    { agent, version: adapter.supportedVersion, now: new Date() },
    "Live capability inspection is not required for an inherit-only update."
  );
  try {
    adapter.validateConfig({ agent, config, workspace, snapshot, validationMode: "replay" });
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
  return createRoleAgentBinding(agent, config);
}

function requiresLiveEnumValidation(config: RoleAgentConfig): boolean {
  if (("model" in config && config.model !== undefined) || ("effort" in config && config.effort !== undefined)) return true;
  if ("permission" in config && config.permission !== undefined) {
    const permission = config.permission as { sandbox?: string; approval?: string; mode?: string };
    if (permission.sandbox !== undefined || permission.approval !== undefined || permission.mode !== undefined) return true;
  }
  return "settingsSources" in config && config.settingsSources !== undefined;
}

function requireAvailableField(
  snapshot: CapabilitySnapshot,
  fieldKey: string,
  option: string,
  adapterId: string
): CapabilityField {
  const field = snapshot.fields.find((candidate) => candidate.key === fieldKey);
  if (field === undefined || field.status === "unavailable") {
    throw usageError(`Role option ${option} is not available for adapter ${adapterId}.`);
  }
  return field;
}

function normalizeSelectedValue(
  raw: string,
  field: CapabilityField | undefined,
  staticValues: readonly string[] | undefined
): string | boolean {
  const value = raw.trim();
  if (staticValues !== undefined && !staticValues.includes(value)) {
    throw usageError(`Value is not available for ${field?.key ?? "Role Agent option"}: ${value}.`);
  }
  if (field?.kind === "boolean") {
    const available = field.choices?.filter((choice) => choice.available).map((choice) => choice.value) ?? [];
    if ((available.length === 0 && value !== "true") || (available.length > 0 && !available.includes(value))) {
      throw usageError(`Value is not available for ${field.key}: ${value}.`);
    }
    return value === "true";
  }
  if (field?.kind === "enum") {
    const available = field.choices?.filter((choice) => choice.available).map((choice) => choice.value);
    if (available !== undefined && !available.includes(value) && !field.allowCustom) {
      throw usageError(`Value is not available for ${field.key}: ${value}.`);
    }
  }
  return value;
}

function setConfigValue(config: RoleAgentConfig, path: string, value: string | boolean | string[]): void {
  const segments = path.split(".");
  let target = config as unknown as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const next = isRecord(target[segment]) ? { ...target[segment] } : {};
    target[segment] = next;
    target = next;
  }
  target[segments.at(-1) ?? path] = Array.isArray(value) ? [...value] : value;
}

function deleteConfigValue(config: RoleAgentConfig, path: string): void {
  const segments = path.split(".");
  const parents: Array<{ parent: Record<string, unknown>; key: string }> = [];
  let target = config as unknown as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    if (!isRecord(target[segment])) return;
    parents.push({ parent: target, key: segment });
    target = target[segment] as Record<string, unknown>;
  }
  delete target[segments.at(-1) ?? path];
  for (const { parent, key } of parents.reverse()) {
    if (isRecord(parent[key]) && Object.keys(parent[key]).length === 0) delete parent[key];
  }
}

function cloneConfig(config: RoleAgentConfig): RoleAgentConfig {
  return JSON.parse(JSON.stringify(config)) as RoleAgentConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
