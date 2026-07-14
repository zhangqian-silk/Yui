import { listAgentDefinitions } from "../agent/agentRegistry.js";
import {
  ROLE_AGENT_OPTION_SPECS,
  ROLE_AGENT_INHERIT_OPTION,
  ROLE_EXPECT_UPDATED_AT_OPTION
} from "../cli/roleOptionCatalog.js";
import { roleNotFound, taskNotFound, usageError } from "../errors/cliError.js";
import {
  inspectAgentCapabilitiesAsync,
  isUnprobedCustomAgent,
  resolveAgentAdapter,
  type CapabilityField,
  type CapabilitySnapshot
} from "../executor/agentAdapter.js";
import type { GlobalRole, Role, RoleAgentConfig } from "../role/role.js";
import type { TaskStore } from "../storage/taskStore.js";
import { runRoleConfigWizard } from "./roleConfigWizard.js";
import type {
  RoleConfigWizardInput,
  RoleConfigWizardResult
} from "./roleWizardTypes.js";

export type RoleWizardCommandGroup = "role" | "task";

export type RoleWizardForegroundInput = {
  group: RoleWizardCommandGroup;
  args: string[];
  store: TaskStore;
  interactive: boolean;
  jsonOutput: boolean;
  question: (prompt: string) => Promise<string>;
};

export type RoleWizardForegroundResult =
  | { status: "ready"; args: string[] }
  | { status: "cancelled"; output: string };

type RoleWizardForegroundDependencies = {
  runWizard?: (
    input: RoleConfigWizardInput,
    dependencies: Parameters<typeof runRoleConfigWizard>[1]
  ) => Promise<RoleConfigWizardResult>;
};

type WizardContext = {
  mode: "add" | "update";
  roleName: string;
  existing?: Role | GlobalRole;
  workspace: string;
};

const ROLE_ADD_OPTIONS = new Set([
  "--workspace", "--description", "--responsibility", "--constraint", "--expected-output",
  "--system-prompt", "--skill", ...ROLE_AGENT_OPTION_SPECS.map(({ option }) => option),
  ROLE_AGENT_INHERIT_OPTION
]);
const TASK_ASSIGN_OPTIONS = new Set([
  "--workspace", "--as", "--system-prompt", ...ROLE_AGENT_OPTION_SPECS.map(({ option }) => option),
  ROLE_AGENT_INHERIT_OPTION
]);
const TASK_ASSIGN_MANY_OPTIONS = new Set([
  "--role", "--workspace", "--system-prompt", ...ROLE_AGENT_OPTION_SPECS.map(({ option }) => option),
  ROLE_AGENT_INHERIT_OPTION
]);

export function needsRoleWizardForeground(
  group: RoleWizardCommandGroup,
  args: string[],
  mode: { interactive: boolean; jsonOutput: boolean }
): boolean {
  if (!mode.interactive || mode.jsonOutput || hasLocalJsonFormat(args)) return false;

  if (group === "role") {
    if (args[0] === "add" && isNonEmpty(args[1])) {
      return !hasOption(args, "--agent") && validOptionTail(args.slice(2), ROLE_ADD_OPTIONS, [
        "--responsibility", "--constraint", "--skill"
      ]);
    }
    return args[0] === "update" && isNonEmpty(args[1]) && args.length === 2;
  }

  if (args[0] === "assign" && isNonEmpty(args[1]) && isNonEmpty(args[2])) {
    return !hasOption(args, "--agent") && validOptionTail(args.slice(3), TASK_ASSIGN_OPTIONS);
  }
  if (args[0] === "assign-many" && isNonEmpty(args[1])) {
    const tail = args.slice(2);
    return !hasOption(args, "--agent") && hasCompleteOption(tail, "--role") &&
      validOptionTail(tail, TASK_ASSIGN_MANY_OPTIONS, ["--role"]);
  }
  return args[0] === "role" && args[1] === "update" && isNonEmpty(args[2]) && isNonEmpty(args[3]) &&
    args.length === 4;
}

export async function resolveRoleWizardForeground(
  input: RoleWizardForegroundInput,
  dependencies: RoleWizardForegroundDependencies = {}
): Promise<RoleWizardForegroundResult> {
  if (!needsRoleWizardForeground(input.group, input.args, input)) {
    return { status: "ready", args: [...input.args] };
  }

  const context = resolveWizardContext(input);
  const agents = listAgentDefinitions(input.store.listConfiguredAgents());
  const currentConfigs = context.existing === undefined
    ? Object.fromEntries(agents.map((agent) => [agent.id, seedConfigFromArgs(input.args, agent.adapterId)]))
    : Object.fromEntries(Object.entries(context.existing.agentBindings).map(([id, binding]) => [id, binding.config]));
  const currentAgentId = context.existing === undefined
    ? undefined
    : resolveConfigurationTarget(input.args, context.existing);
  const wizardInput: RoleConfigWizardInput = {
    mode: context.mode,
    roleName: context.roleName,
    agents,
    defaultAgentId: input.store.getConfig().defaultAgent,
    currentAgentId,
    currentConfigs
  };
  const runWizard = dependencies.runWizard ?? runRoleConfigWizard;

  let result: RoleConfigWizardResult;
  try {
    result = await runWizard(wizardInput, {
      question: async (prompt) => {
        try {
          return await input.question(prompt);
        } catch (error) {
          if (isReadlineCancellation(error)) return "cancel";
          throw error;
        }
      },
      inspectCapabilities: inspectAgentCapabilitiesAsync,
      validateAgentSelection: ({ agent, snapshot }) => {
        validateStructuredSeed(input.args, agent, snapshot, context.workspace);
      },
      canKeepUnavailableValue: ({ agent, snapshot, fieldKey, value, draftConfig }) => {
        const candidate = cloneConfig(draftConfig);
        setPath(candidate, fieldKey, normalizeWizardValue(value));
        try {
          resolveAgentAdapter(agent.adapterId).validateConfig({
            agent,
            config: candidate,
            workspace: context.workspace,
            snapshot,
            validationMode: configurationValidationMode(agent, snapshot)
          });
          return true;
        } catch {
          return false;
        }
      },
      validateSelection: ({ agent, snapshot, selection }) => {
        resolveAgentAdapter(agent.adapterId).validateConfig({
          agent,
          config: selection.config,
          workspace: context.workspace,
          snapshot,
          validationMode: configurationValidationMode(agent, snapshot)
        });
      }
    });
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }

  if (result.status === "cancelled") {
    return { status: "cancelled", output: "Cancelled.\n" };
  }

  const existingConfig = context.existing?.agentBindings[result.selection.agentId]?.config;
  return {
    status: "ready",
    args: [
      ...stripAgentConfigArgs(input.args),
      ...(context.mode === "update" && context.existing !== undefined
        ? [ROLE_EXPECT_UPDATED_AT_OPTION, context.existing.updatedAt]
        : []),
      "--agent", result.selection.agentId,
      ...serializeRoleAgentConfig(result.selection.config, context.mode === "update" ? existingConfig : undefined)
    ]
  };
}

function validateStructuredSeed(
  args: string[],
  agent: ReturnType<typeof listAgentDefinitions>[number],
  snapshot: CapabilitySnapshot,
  workspace: string
): void {
  const seedArgs = extractAgentConfigArgs(args);
  if (seedArgs.length === 0) return;

  const config = { adapterId: agent.adapterId } as RoleAgentConfig;
  for (let index = 0; index < seedArgs.length; index += 2) {
    const option = seedArgs[index];
    const raw = seedArgs[index + 1];
    if (option === ROLE_AGENT_INHERIT_OPTION) {
      const inherited = ROLE_AGENT_OPTION_SPECS.find(({ fieldKey }) => fieldKey === raw);
      if (inherited !== undefined && !inherited.adapters.some((candidate) => candidate === agent.adapterId)) {
        throw usageError(`Role Agent field ${raw} is not available for adapter ${agent.adapterId}.`);
      }
      continue;
    }
    const spec = ROLE_AGENT_OPTION_SPECS.find((candidate) => candidate.option === option);
    if (spec === undefined) continue;
    if (!spec.adapters.some((candidate) => candidate === agent.adapterId)) {
      throw usageError(`Role option ${option} is not available for adapter ${agent.adapterId}.`);
    }
    if (spec.staticValues !== undefined && !spec.staticValues.includes(raw)) {
      throw usageError(`Value is not available for ${spec.fieldKey}: ${raw}.`);
    }
    const field = spec.fieldKey === "advanced.rawArgs"
      ? undefined
      : requireSeedField(snapshot, spec.fieldKey, option, agent.adapterId);
    const value = normalizeSeedValue(raw, field);
    if (spec.repeatable) {
      const current = readPath(config, spec.fieldKey);
      setPath(config, spec.fieldKey, [...(Array.isArray(current) ? current : []), String(value)]);
    } else {
      setPath(config, spec.fieldKey, value);
    }
  }
  resolveAgentAdapter(agent.adapterId).validateConfig({
    agent,
    config,
    workspace,
    snapshot,
    validationMode: configurationValidationMode(agent, snapshot)
  });
}

function configurationValidationMode(
  agent: ReturnType<typeof listAgentDefinitions>[number],
  snapshot: CapabilitySnapshot
): "configure" | "unprobed" {
  return isUnprobedCustomAgent(agent, snapshot) ? "unprobed" : "configure";
}

function requireSeedField(
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

function normalizeSeedValue(raw: string, field: CapabilityField | undefined): string | boolean {
  if (field?.kind === "boolean") {
    const available = field.choices?.filter(({ available }) => available).map(({ value }) => value) ?? [];
    if (!available.includes(raw)) throw usageError(`Value is not available for ${field.key}: ${raw}.`);
    return raw === "true";
  }
  if (field?.kind === "enum") {
    const available = field.choices?.filter(({ available }) => available).map(({ value }) => value);
    if (available !== undefined && !field.allowCustom && !available.includes(raw)) {
      throw usageError(`Value is not available for ${field.key}: ${raw}.`);
    }
  }
  return raw;
}

function extractAgentConfigArgs(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (ROLE_AGENT_OPTION_SPECS.some(({ option }) => option === value)) {
      if (args[index + 1] !== undefined) result.push(value, args[index + 1]);
      index += 1;
      continue;
    }
    if (value === ROLE_AGENT_INHERIT_OPTION &&
      ROLE_AGENT_OPTION_SPECS.some(({ fieldKey }) => fieldKey === args[index + 1])) {
      result.push(value, args[index + 1]);
      index += 1;
    }
  }
  return result;
}

function seedConfigFromArgs(args: string[], adapterId: string): RoleAgentConfig {
  const config = { adapterId } as RoleAgentConfig;
  for (let index = 0; index < args.length; index += 1) {
    const spec = ROLE_AGENT_OPTION_SPECS.find(({ option }) => option === args[index]);
    if (spec === undefined) continue;
    const raw = args[index + 1];
    if (raw === undefined || (!spec.adapters.some((candidate) => candidate === adapterId) && spec.option !== "--raw-arg")) {
      index += raw === undefined ? 0 : 1;
      continue;
    }
    const value: string | boolean = spec.fieldKey === "search" ? raw === "true" : raw;
    if (spec.repeatable) {
      const current = readPath(config, spec.fieldKey);
      setPath(config, spec.fieldKey, [...(Array.isArray(current) ? current : []), String(value)]);
    } else {
      setPath(config, spec.fieldKey, value);
    }
    index += 1;
  }
  return config;
}

function stripAgentConfigArgs(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (ROLE_AGENT_OPTION_SPECS.some(({ option }) => option === args[index])) {
      index += 1;
      continue;
    }
    if (args[index] === ROLE_AGENT_INHERIT_OPTION &&
      ROLE_AGENT_OPTION_SPECS.some(({ fieldKey }) => fieldKey === args[index + 1])) {
      index += 1;
      continue;
    }
    result.push(args[index]);
  }
  return result;
}

function resolveWizardContext(input: RoleWizardForegroundInput): WizardContext {
  const defaultWorkspace = input.store.getConfig().defaultWorkspace;
  if (input.group === "role" && input.args[0] === "add") {
    return {
      mode: "add",
      roleName: input.args[1],
      workspace: optionValue(input.args, "--workspace") ?? defaultWorkspace ?? process.cwd()
    };
  }
  if (input.group === "role") {
    const roleName = input.args[1];
    const existing = input.store.getGlobalRole(roleName);
    if (existing === null) throw roleNotFound(roleName);
    return { mode: "update", roleName, existing, workspace: existing.workspace };
  }
  const taskId = input.args[0] === "role" ? input.args[2] : input.args[1];
  if (input.store.getTask(taskId) === null) throw taskNotFound(taskId);
  if (input.args[0] === "assign") {
    return {
      mode: "add",
      roleName: optionValue(input.args, "--as") ?? input.args[2],
      workspace: optionValue(input.args, "--workspace") ?? defaultWorkspace ?? process.cwd()
    };
  }
  if (input.args[0] === "assign-many") {
    return {
      mode: "add",
      roleName: "assigned roles",
      workspace: optionValue(input.args, "--workspace") ?? defaultWorkspace ?? process.cwd()
    };
  }
  const roleName = input.args[3];
  const existing = input.store.getRole(taskId, roleName);
  if (existing === null) throw roleNotFound(roleName);
  return { mode: "update", roleName, existing, workspace: existing.workspace };
}

function resolveConfigurationTarget(args: string[], role: Role | GlobalRole): string {
  return optionValue(args, "--agent") ?? optionValue(args, "--active-agent") ?? role.activeAgentId;
}

function serializeRoleAgentConfig(config: RoleAgentConfig, existing?: RoleAgentConfig): string[] {
  const args: string[] = [];
  for (const spec of ROLE_AGENT_OPTION_SPECS) {
    const value = readPath(config, spec.fieldKey);
    if (Array.isArray(value)) {
      for (const item of value) args.push(spec.option, String(item));
    } else if (typeof value === "string" || typeof value === "boolean") {
      args.push(spec.option, String(value));
    }
  }
  if (existing !== undefined) {
    for (const spec of ROLE_AGENT_OPTION_SPECS) {
      if (readPath(existing, spec.fieldKey) !== undefined && readPath(config, spec.fieldKey) === undefined) {
        args.push(ROLE_AGENT_INHERIT_OPTION, spec.fieldKey);
      }
    }
  }
  return args;
}

function validOptionTail(
  args: string[],
  allowed: ReadonlySet<string>,
  additionalRepeatable: readonly string[] = []
): boolean {
  const repeatable = new Set([
    ROLE_AGENT_INHERIT_OPTION,
    ...ROLE_AGENT_OPTION_SPECS.filter(({ repeatable }) => repeatable).map(({ option }) => option),
    ...additionalRepeatable
  ]);
  const seen = new Set<string>();
  const inherited = new Set<string>();
  const selectedFields = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!allowed.has(option) || value === undefined) return false;
    const allowsOptionLikeValue = ROLE_AGENT_OPTION_SPECS.find(
      ({ option: candidate }) => candidate === option
    )?.allowOptionLikeValue === true;
    if (!allowsOptionLikeValue && value.startsWith("--")) return false;
    if (!repeatable.has(option) && seen.has(option)) return false;
    seen.add(option);
    if (option === ROLE_AGENT_INHERIT_OPTION) {
      if (!ROLE_AGENT_OPTION_SPECS.some(({ fieldKey }) => fieldKey === value) || selectedFields.has(value)) return false;
      inherited.add(value);
      continue;
    }
    const fieldKey = ROLE_AGENT_OPTION_SPECS.find(({ option: candidate }) => candidate === option)?.fieldKey;
    if (fieldKey !== undefined) {
      if (inherited.has(fieldKey)) return false;
      selectedFields.add(fieldKey);
    }
  }
  return true;
}

function hasLocalJsonFormat(args: string[]): boolean {
  return optionValue(args, "--format")?.toLocaleLowerCase() === "json";
}

function hasOption(args: string[], option: string): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) continue;
    if (value === option) return true;
    index += 1;
  }
  return false;
}

function hasCompleteOption(args: string[], option: string): boolean {
  return optionValue(args, option) !== undefined;
}

function optionValue(args: string[], option: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const candidate = args[index];
    if (!candidate.startsWith("--")) continue;
    const value = args[index + 1];
    if (candidate === option) {
      return value === undefined || value.startsWith("--") ? undefined : value;
    }
    index += 1;
  }
  return undefined;
}

function readPath(config: RoleAgentConfig, path: string): unknown {
  let value: unknown = config;
  for (const segment of path.split(".")) {
    if (!isRecord(value)) return undefined;
    value = value[segment];
  }
  return value;
}

function setPath(config: RoleAgentConfig, path: string, value: string | boolean | string[]): void {
  const segments = path.split(".");
  let target = config as unknown as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const nested = isRecord(target[segment]) ? { ...target[segment] } : {};
    target[segment] = nested;
    target = nested;
  }
  target[segments.at(-1) ?? path] = Array.isArray(value) ? [...value] : value;
}

function normalizeWizardValue(value: unknown): string | boolean | string[] {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return [...value];
  throw usageError("Role Agent value is not valid.");
}

function cloneConfig(config: RoleAgentConfig): RoleAgentConfig {
  return JSON.parse(JSON.stringify(config)) as RoleAgentConfig;
}

function isNonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0 && !value.startsWith("--");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReadlineCancellation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String(error.code) : "";
  return code === "ABORT_ERR" || code === "ERR_USE_AFTER_CLOSE" ||
    /aborted with ctrl\+d|readline (?:interface )?was closed/i.test(error.message);
}
