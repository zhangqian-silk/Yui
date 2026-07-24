import { isAgentAdapterId, type AgentAdapterId } from "./adapterCatalog.js";
import { validateAgentBaseArguments } from "./argumentPolicy.js";

export type EnvironmentBinding = Readonly<{
  target: string;
  source: "process";
  sourceName: string;
  required: boolean;
}>;

/** FileTaskStore-safe Agent record. There is deliberately no probe runtime state here. */
export type ConfiguredAgent = Readonly<{
  schemaVersion: 2;
  id: string;
  adapterId: AgentAdapterId;
  command: string;
  baseArgs: readonly string[];
  environment: readonly EnvironmentBinding[];
  createdAt: string;
  updatedAt: string;
}>;

export type AgentDefinition = ConfiguredAgent & Readonly<{ source: "custom" }>;

export function createConfiguredAgent(
  id: string,
  adapterId: string,
  command: string,
  baseArgs: readonly string[],
  environment: readonly EnvironmentBinding[],
  now: Date
): ConfiguredAgent {
  const normalizedId = requireSafeIdentity(id, "Agent id");
  if (!isAgentAdapterId(adapterId)) throw new Error(`Agent adapter is unsupported: ${adapterId}.`);
  const normalizedCommand = requireText(command, "Agent command");
  validateAgentBaseArguments(adapterId, baseArgs);
  const timestamp = now.toISOString();
  return {
    schemaVersion: 2,
    id: normalizedId,
    adapterId,
    command: normalizedCommand,
    baseArgs: [...baseArgs],
    environment: environment.map(validateEnvironmentBinding),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function configuredAgentToDefinition(agent: ConfiguredAgent): AgentDefinition {
  validateConfiguredAgent(agent);
  return {
    ...agent,
    baseArgs: [...agent.baseArgs],
    environment: agent.environment.map((binding) => ({ ...binding })),
    source: "custom"
  };
}

export function resolveAgentEnvironment(
  agent: Pick<AgentDefinition, "environment">,
  processEnvironment: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return Object.fromEntries(agent.environment.flatMap((binding) => {
    const normalized = validateEnvironmentBinding(binding);
    const value = processEnvironment[normalized.sourceName];
    if (value === undefined) {
      if (normalized.required) {
        throw new Error(`Required Agent environment is missing: ${normalized.sourceName}.`);
      }
      return [];
    }
    return [[normalized.target, value]];
  }));
}

export function validateConfiguredAgent(agent: ConfiguredAgent): void {
  if (agent.schemaVersion !== 2) throw new Error("Agent schema version is invalid.");
  requireSafeIdentity(agent.id, "Agent id");
  if (!isAgentAdapterId(agent.adapterId)) throw new Error(`Agent adapter is unsupported: ${agent.adapterId}.`);
  requireText(agent.command, "Agent command");
  validateAgentBaseArguments(agent.adapterId, agent.baseArgs);
  if (!Array.isArray(agent.environment)) throw new Error("Agent environment must be an array.");
  agent.environment.forEach(validateEnvironmentBinding);
  requireText(agent.createdAt, "Agent creation timestamp");
  requireText(agent.updatedAt, "Agent update timestamp");
}

function validateEnvironmentBinding(binding: EnvironmentBinding): EnvironmentBinding {
  if (binding === null || typeof binding !== "object" || Array.isArray(binding)) {
    throw new Error("Agent environment binding must be an object.");
  }
  if (binding.source !== "process" || typeof binding.required !== "boolean"
    || !isEnvironmentName(binding.target) || !isEnvironmentName(binding.sourceName)
    || binding.target.startsWith("YUI_")) {
    throw new Error("Agent environment binding is invalid.");
  }
  return {
    target: binding.target,
    source: "process",
    sourceName: binding.sourceName,
    required: binding.required
  };
}

function isEnvironmentName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function requireSafeIdentity(value: string, label: string): string {
  const normalized = requireText(value, label);
  if (["__proto__", "prototype", "constructor"].includes(normalized) || /[\/\\\0]/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}
