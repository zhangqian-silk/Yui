import { basename } from "node:path";
import { types as utilTypes } from "node:util";
import type { AgentDefinition, EnvironmentBinding } from "../agent/agent.js";
import type {
  AgentInstallation,
  CapabilityChoice,
  CapabilityField,
  CapabilitySnapshot
} from "../executor/agentAdapter.js";
import type { GlobalRole, Role } from "../role/role.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_ADAPTER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SAFE_ENUM = /^[A-Za-z0-9][A-Za-z0-9._+:/-]{0,127}$/;
const SAFE_VERSION = /^\d+\.\d+\.\d+$/;
const SAFE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const FIELD_CATALOG = Object.freeze({
  model: "Model",
  effort: "Reasoning effort",
  "permission.sandbox": "Sandbox",
  "permission.approval": "Approval",
  "permission.mode": "Permission mode",
  "permission.allowedTools": "Allowed tools",
  "permission.disallowedTools": "Disallowed tools",
  profile: "Profile",
  search: "Web search",
  additionalDirectories: "Additional directories",
  settingsFile: "Settings",
  settingsSources: "Settings sources"
} as const);

export type PublicEnvironmentBinding = {
  key: string;
  source: "process";
  required: boolean;
  value: "redacted";
};

export type PublicAgentDefinition = {
  id: string;
  adapterId: string;
  source: "custom";
  executable: string;
  arguments: string;
  environment: PublicEnvironmentBinding[];
};

export type PublicAgentInstallation = {
  status: AgentInstallation["status"];
  version?: string;
  probedAt: string;
};

export type PublicCapabilityChoice = Pick<CapabilityChoice, "value" | "source" | "available">;

export type PublicCapabilityField = {
  key: keyof typeof FIELD_CATALOG;
  label: string;
  kind: CapabilityField["kind"];
  status: CapabilityField["status"];
  source: CapabilityField["source"];
  refreshedAt: string;
  choices?: PublicCapabilityChoice[];
  choicesByModel?: Record<string, PublicCapabilityChoice[]>;
  defaultByModel?: Record<string, string>;
  allowInherit: true;
  allowClear: true;
  defaultPolicy: "inherit";
  allowCustom: boolean;
};

export type PublicCapabilitySnapshot = {
  schemaVersion: 1;
  agentId: string;
  adapterId: string;
  installation: PublicAgentInstallation;
  lifecycle: CapabilitySnapshot["lifecycle"];
  fields: PublicCapabilityField[];
  warnings: [];
  refreshedAt: string;
  refreshAction?: string;
};

export type PublicRolePresentation = {
  name: string;
  activeAgentId: string;
  boundAgentCount: number;
  workspace: "configured";
  profile: {
    description: "configured" | "unset";
    responsibilities: string;
    constraints: string;
    expectedOutput: "configured" | "unset";
    systemPrompt: "configured" | "unset";
    skills: string;
  };
  bindings: Array<{
    agentId: string;
    active: boolean;
    adapterId: string;
    configuration: string;
    arguments: string;
  }>;
};

export function presentAgentDefinition(agent: AgentDefinition): PublicAgentDefinition {
  assertPlainRecord(agent, "Agent definition");
  const id = safeId(agent.id, "Agent id");
  const adapterId = safeAdapter(agent.adapterId);
  const command = ownString(agent, "command", "Agent command");
  const args = ownArray(agent, "baseArgs", "Agent base arguments");
  const environment = ownArray(agent, "environment", "Agent environment");
  return {
    id,
    adapterId,
    source: "custom",
    executable: safeExecutableName(command, adapterId),
    arguments: `${args.length} args hidden`,
    environment: environment.map((binding) => presentEnvironmentBinding(binding))
  };
}

export function presentCapabilitySnapshot(snapshot: CapabilitySnapshot): PublicCapabilitySnapshot {
  assertPlainRecord(snapshot, "Capability snapshot");
  const fields = ownArray(snapshot, "fields", "Capability fields").map((field) => presentField(field));
  const lifecycle = ownRecord(snapshot, "lifecycle", "Capability lifecycle");
  const agentId = safeId(ownString(snapshot, "agentId", "Capability Agent id"), "Capability Agent id");
  const installation = presentAgentInstallation(ownRecord(snapshot, "installation", "Agent installation") as AgentInstallation);
  return {
    schemaVersion: 1,
    agentId,
    adapterId: safeAdapter(ownString(snapshot, "adapterId", "Capability adapter id")),
    installation,
    lifecycle: {
      start: ownBoolean(lifecycle, "start"),
      resume: ownBoolean(lifecycle, "resume"),
      nativeSessionDiscovery: ownNativeDiscovery(lifecycle),
      interrupt: ownBoolean(lifecycle, "interrupt")
    },
    fields,
    warnings: [],
    refreshedAt: safeTimestamp(ownString(snapshot, "refreshedAt", "Capability refresh time")),
    ...(installation.status === "refresh-required"
      ? { refreshAction: `taskmux agent update ${agentId} --refresh-probe` }
      : {})
  };
}

export function publicAgentErrorDetails(agentId: string, adapterId?: string): Record<string, string> {
  return {
    agentId: safeId(agentId, "Agent id"),
    ...(adapterId === undefined ? {} : { adapterId: safeAdapter(adapterId) })
  };
}

export function presentRole(role: Role | GlobalRole): PublicRolePresentation {
  assertPlainRecord(role, "Role");
  const name = safeId(ownString(role, "name", "Role name"), "Role name");
  const activeAgentId = safeId(ownString(role, "activeAgentId", "Role Agent id"), "Role Agent id");
  const bindingsRecord = ownRecord(role, "agentBindings", "Role Agent bindings");
  const bindings = ownKeys(bindingsRecord).sort((left, right) => left.localeCompare(right)).map((agentId) => {
    const descriptor = Object.getOwnPropertyDescriptor(bindingsRecord, agentId);
    if (descriptor === undefined || !("value" in descriptor)) throw new Error("Role Agent binding is invalid.");
    assertPlainRecord(descriptor.value, "Role Agent binding");
    const binding = descriptor.value;
    const storedAgentId = safeId(ownString(binding, "agentId", "Role Agent id"), "Role Agent id");
    if (storedAgentId !== agentId) throw new Error("Role Agent binding identity is invalid.");
    const config = ownRecord(binding, "config", "Role Agent configuration");
    const summary = summarizeRoleConfig(config);
    return {
      agentId: storedAgentId,
      active: storedAgentId === activeAgentId,
      adapterId: safeAdapter(ownString(binding, "adapterId", "Role adapter id")),
      configuration: `${summary.values} values hidden`,
      arguments: `${summary.arguments} args hidden`
    };
  });
  return {
    name,
    activeAgentId,
    boundAgentCount: bindings.length,
    workspace: "configured",
    profile: {
      description: configuredString(role, "description"),
      responsibilities: configuredArrayCount(role, "responsibilities", "items"),
      constraints: configuredArrayCount(role, "constraints", "items"),
      expectedOutput: configuredString(role, "expectedOutput"),
      systemPrompt: configuredString(role, "systemPrompt"),
      skills: configuredArrayCount(role, "skills", "items")
    },
    bindings
  };
}

export function presentAgentInstallation(installation: AgentInstallation): PublicAgentInstallation {
  assertPlainRecord(installation, "Agent installation");
  const status = ownString(installation, "status", "Agent installation status");
  if (!["installed", "missing", "unsupported-version", "probe-failed", "unsafe-output", "unavailable", "refresh-required"].includes(status)) {
    throw new Error("Agent installation status is invalid.");
  }
  const version = ownOptionalString(installation, "version");
  return {
    status: status as AgentInstallation["status"],
    ...(version === undefined ? {} : { version: safeVersion(version) }),
    probedAt: safeTimestamp(ownString(installation, "probedAt", "Agent probe time"))
  };
}

function presentField(value: unknown): PublicCapabilityField {
  assertPlainRecord(value, "Capability field");
  const key = ownString(value, "key", "Capability field key") as keyof typeof FIELD_CATALOG;
  const label = FIELD_CATALOG[key];
  if (label === undefined) throw new Error("Capability field key is unsupported.");
  const kind = ownString(value, "kind", "Capability field kind") as CapabilityField["kind"];
  const status = ownString(value, "status", "Capability field status") as CapabilityField["status"];
  const source = ownString(value, "source", "Capability field source") as CapabilityField["source"];
  if (!["enum", "boolean", "string", "string-list", "path", "path-list"].includes(kind) ||
      !["available", "degraded", "unavailable"].includes(status) ||
      !["installed-cli", "installed-cli-bundled", "installed-cli-help", "adapter-baseline"].includes(source)) {
    throw new Error("Capability field metadata is invalid.");
  }
  const choices = ownOptionalArray(value, "choices");
  const choicesByModel = ownOptionalRecord(value, "choicesByModel");
  const defaultByModel = ownOptionalRecord(value, "defaultByModel");
  return {
    key,
    label,
    kind,
    status,
    source,
    refreshedAt: safeTimestamp(ownString(value, "refreshedAt", "Capability field refresh time")),
    ...(choices === undefined ? {} : { choices: choices.map(presentChoice) }),
    ...(choicesByModel === undefined ? {} : { choicesByModel: presentChoicesByModel(choicesByModel) }),
    ...(defaultByModel === undefined ? {} : { defaultByModel: presentDefaultsByModel(defaultByModel) }),
    allowInherit: true,
    allowClear: true,
    defaultPolicy: "inherit",
    allowCustom: ownBoolean(value, "allowCustom")
  };
}

function presentChoice(value: unknown): PublicCapabilityChoice {
  assertPlainRecord(value, "Capability choice");
  const source = ownString(value, "source", "Capability choice source") as CapabilityChoice["source"];
  if (!["installed-cli", "installed-cli-bundled", "installed-cli-help", "adapter-baseline"].includes(source)) {
    throw new Error("Capability choice source is invalid.");
  }
  return {
    value: safeEnum(ownString(value, "value", "Capability choice")),
    source,
    available: ownBoolean(value, "available")
  };
}

function presentChoicesByModel(value: Record<string, unknown>): Record<string, PublicCapabilityChoice[]> {
  const result: Record<string, PublicCapabilityChoice[]> = Object.create(null);
  for (const key of ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !Array.isArray(descriptor.value)) {
      throw new Error("Capability choices by model are invalid.");
    }
    result[safeEnum(key)] = ownArrayValue(descriptor.value, "Capability model choices").map(presentChoice);
  }
  return result;
}

function presentDefaultsByModel(value: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const key of ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw new Error("Capability defaults by model are invalid.");
    }
    result[safeEnum(key)] = safeEnum(descriptor.value);
  }
  return result;
}

function presentEnvironmentBinding(value: unknown): PublicEnvironmentBinding {
  assertPlainRecord(value, "Agent environment binding");
  const key = ownString(value, "target", "Agent environment key");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Agent environment key is invalid.");
  if (ownString(value, "source", "Agent environment source") !== "process") {
    throw new Error("Agent environment source is invalid.");
  }
  return { key, source: "process", required: ownBoolean(value, "required"), value: "redacted" };
}

function summarizeRoleConfig(value: Record<string, unknown>): { values: number; arguments: number } {
  let values = 0;
  let argumentsCount = 0;
  const visit = (record: Record<string, unknown>, prefix: string): void => {
    for (const key of ownKeys(record)) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined || !("value" in descriptor)) throw new Error("Role Agent configuration is invalid.");
      const path = prefix.length === 0 ? key : `${prefix}.${key}`;
      if (path === "adapterId") continue;
      if (path === "advanced.rawArgs") {
        argumentsCount += ownArrayValue(descriptor.value, "Role raw arguments").length;
        continue;
      }
      if (Array.isArray(descriptor.value)) {
        values += ownArrayValue(descriptor.value, "Role Agent configuration").length;
      } else if (typeof descriptor.value === "object" && descriptor.value !== null) {
        assertPlainRecord(descriptor.value, "Role Agent configuration");
        visit(descriptor.value, path);
      } else if (typeof descriptor.value === "string" || typeof descriptor.value === "boolean") {
        values += 1;
      } else if (descriptor.value !== undefined) {
        throw new Error("Role Agent configuration is invalid.");
      }
    }
  };
  visit(value, "");
  return { values, arguments: argumentsCount };
}

function configuredString(value: Record<string, unknown>, key: string): "configured" | "unset" {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || descriptor.value === undefined) return "unset";
  if (!("value" in descriptor) || typeof descriptor.value !== "string") throw new Error(`Role ${key} is invalid.`);
  return descriptor.value.length === 0 ? "unset" : "configured";
}

function configuredArrayCount(value: Record<string, unknown>, key: string, label: string): string {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || descriptor.value === undefined) return `0 ${label}`;
  if (!("value" in descriptor)) throw new Error(`Role ${key} is invalid.`);
  return `${ownArrayValue(descriptor.value, `Role ${key}`).length} ${label}`;
}

function safeExecutableName(command: string, adapterId: string): string {
  const value = basename(command.replaceAll("\\", "/"));
  return value === adapterId ? adapterId : "configured";
}

function safeId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function safeAdapter(value: string): string {
  if (!SAFE_ADAPTER.test(value)) throw new Error("Agent adapter id is invalid.");
  return value;
}

function safeEnum(value: string): string {
  if (!SAFE_ENUM.test(value)) throw new Error("Capability enum is invalid.");
  return value;
}

function safeVersion(value: string): string {
  if (!SAFE_VERSION.test(value)) throw new Error("Agent version is invalid.");
  return value;
}

function safeTimestamp(value: string): string {
  if (!SAFE_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) throw new Error("Capability timestamp is invalid.");
  return value;
}

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new Error(`${label} is invalid.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} is invalid.`);
}

function ownString(value: Record<string, unknown>, key: string, label: string): string {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") {
    throw new Error(`${label} is invalid.`);
  }
  return descriptor.value;
}

function ownOptionalString(value: Record<string, unknown>, key: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor) || typeof descriptor.value !== "string") throw new Error(`${key} is invalid.`);
  return descriptor.value;
}

function ownBoolean(value: Record<string, unknown>, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "boolean") {
    throw new Error(`${key} is invalid.`);
  }
  return descriptor.value;
}

function ownArray(value: Record<string, unknown>, key: string, label: string): unknown[] {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) throw new Error(`${label} is invalid.`);
  return ownArrayValue(descriptor.value, label);
}

function ownOptionalArray(value: Record<string, unknown>, key: string): unknown[] | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw new Error(`${key} is invalid.`);
  return ownArrayValue(descriptor.value, key);
}

function ownArrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new Error(`${label} is invalid.`);
  }
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (typeof length !== "number") throw new Error(`${label} is invalid.`);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) throw new Error(`${label} is invalid.`);
    result.push(descriptor.value);
  }
  return result;
}

function ownRecord(value: Record<string, unknown>, key: string, label: string): Record<string, unknown> {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) throw new Error(`${label} is invalid.`);
  assertPlainRecord(descriptor.value, label);
  return descriptor.value;
}

function ownOptionalRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw new Error(`${key} is invalid.`);
  assertPlainRecord(descriptor.value, key);
  return descriptor.value;
}

function ownKeys(value: Record<string, unknown>): string[] {
  if (utilTypes.isProxy(value)) throw new Error("Capability record is invalid.");
  const keys = Reflect.ownKeys(value);
  if (!keys.every((key): key is string => typeof key === "string")) throw new Error("Capability record is invalid.");
  return keys;
}

function ownNativeDiscovery(value: Record<string, unknown>): CapabilitySnapshot["lifecycle"]["nativeSessionDiscovery"] {
  const discovery = ownString(value, "nativeSessionDiscovery", "Native discovery mode");
  if (discovery !== "runtime" && discovery !== "preallocated" && discovery !== "none") {
    throw new Error("Native discovery mode is invalid.");
  }
  return discovery;
}
