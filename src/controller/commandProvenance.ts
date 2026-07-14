import { isAbsolute, resolve } from "node:path";
import { resolveAgent } from "../agent/agentRegistry.js";
import type { ManualSessionRegistration } from "../commands/sessionRegistration.js";
import {
  captureProbeExecutableResolutionContext,
  type ProbeExecutableResolutionContext
} from "../executor/agentAdapter.js";
import { resolveAgentLaunchEnvironment, resolveAgentSessionRoot } from "../executor/executorRegistry.js";
import { activeRoleAgentBinding } from "../role/role.js";
import type { TaskStore } from "../storage/taskStore.js";

const COMMAND_PROVENANCE_ENV_KEYS = [
  "TASKMUX_TASK_ID",
  "TASKMUX_ROLE",
  "TASKMUX_RUN_ID",
  "TASKMUX_AGENT_ID",
  "TASKMUX_ADAPTER_ID",
  "TASKMUX_NATIVE_SESSION_ROOT",
  "TASKMUX_NATIVE_SESSION_ID",
  "TASKMUX_OPERATOR_LAUNCH_TOKEN",
  "CODEX_THREAD_ID"
] as const;

export type ParsedControllerCommandProvenance = {
  environment: NodeJS.ProcessEnv;
  sessionRegistration?: ManualSessionRegistration;
  agentProbeResolution?: ProbeExecutableResolutionContext;
};

export function buildControllerCommandProvenance(
  group: string,
  args: string[],
  store: TaskStore,
  environment: NodeJS.ProcessEnv
): Record<string, unknown> | undefined {
  const entries = COMMAND_PROVENANCE_ENV_KEYS.flatMap((key) =>
    environment[key] === undefined ? [] : [[key, environment[key]] as const]
  );
  const sessionRegistration = resolveManualSessionRegistration(group, args, store, environment);
  const agentProbeResolution = group === "import" ||
    (group === "agent" && (args[0] === "add" || args[0] === "update"))
    ? captureProbeExecutableResolutionContext(environment)
    : undefined;
  if (entries.length === 0 && sessionRegistration === undefined && agentProbeResolution === undefined) return undefined;
  return {
    ...Object.fromEntries(entries),
    ...(sessionRegistration === undefined ? {} : { sessionRegistration }),
    ...(agentProbeResolution === undefined ? {} : { agentProbeResolution })
  };
}

export function parseControllerCommandProvenance(params: object): ParsedControllerCommandProvenance | null {
  const paramsDescriptors = Object.getOwnPropertyDescriptors(params);
  const provenanceDescriptor = paramsDescriptors.provenance;
  if (provenanceDescriptor === undefined || provenanceDescriptor.value === undefined) return { environment: {} };
  if (provenanceDescriptor.get !== undefined || provenanceDescriptor.set !== undefined) return null;
  const value = provenanceDescriptor.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set<string>([...COMMAND_PROVENANCE_ENV_KEYS, "sessionRegistration", "agentProbeResolution"]);
  if (Object.keys(descriptors).some((key) => !allowed.has(key))) return null;
  if (Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)) {
    return null;
  }
  const parsedEnvironment: NodeJS.ProcessEnv = {};
  for (const key of COMMAND_PROVENANCE_ENV_KEYS) {
    const item = descriptors[key]?.value;
    if (item === undefined) continue;
    if (typeof item !== "string") return null;
    parsedEnvironment[key] = item;
  }
  const registrationValue = descriptors.sessionRegistration?.value;
  const sessionRegistration = registrationValue === undefined
    ? undefined
    : parseManualSessionRegistration(registrationValue);
  if (registrationValue !== undefined && sessionRegistration === null) return null;
  const resolutionValue = descriptors.agentProbeResolution?.value;
  const agentProbeResolution = resolutionValue === undefined
    ? undefined
    : parseProbeExecutableResolutionContext(resolutionValue);
  if (resolutionValue !== undefined && agentProbeResolution === null) return null;
  return {
    environment: parsedEnvironment,
    ...(sessionRegistration === undefined || sessionRegistration === null ? {} : { sessionRegistration }),
    ...(agentProbeResolution === undefined || agentProbeResolution === null ? {} : { agentProbeResolution })
  };
}

function parseProbeExecutableResolutionContext(value: unknown): ProbeExecutableResolutionContext | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(descriptors).length !== 1 ||
    !Object.hasOwn(descriptors, "searchPath") ||
    descriptors.searchPath?.get !== undefined ||
    descriptors.searchPath?.set !== undefined
  ) {
    return null;
  }
  const searchPath = descriptors.searchPath.value;
  if (!Array.isArray(searchPath)) return null;
  const entryDescriptors = Object.getOwnPropertyDescriptors(searchPath);
  const entries = Array.from({ length: searchPath.length }, (_, index) =>
    entryDescriptors[String(index)]?.value);
  if (
    Object.keys(entryDescriptors).length !== searchPath.length + 1 ||
    Object.values(entryDescriptors).some((descriptor) =>
      descriptor.get !== undefined || descriptor.set !== undefined) ||
    entries.length === 0 ||
    entries.length > 256 ||
    entries.reduce((total, directory) =>
      total + (typeof directory === "string" ? directory.length : 0), entries.length - 1) > 32_768 ||
    entries.some((directory) =>
      typeof directory !== "string" ||
      directory.length === 0 ||
      directory.length > 4_096 ||
      !isAbsolute(directory) ||
      resolve(directory) !== directory ||
      /[\0\r\n]/.test(directory)
    )
  ) {
    return null;
  }
  return { searchPath: [...new Set(entries as string[])] };
}

function resolveManualSessionRegistration(
  group: string,
  args: string[],
  store: TaskStore,
  environment: NodeJS.ProcessEnv
): ManualSessionRegistration | undefined {
  if (args[0] !== "session" || (args[1] !== "record" && args[1] !== "replace")) return undefined;
  const role = group === "task"
    ? args[2] === undefined || args[3] === undefined ? null : store.getRole(args[2], args[3])
    : group === "role" && args[2] !== undefined ? store.getGlobalRole(args[2]) : null;
  if (role === null) return undefined;
  const binding = activeRoleAgentBinding(role);
  const agent = resolveAgent(binding.agentId, store.listConfiguredAgents());
  if (agent === null) return undefined;
  const launchEnvironment = resolveAgentLaunchEnvironment(agent, environment);
  const sessionRoot = resolveAgentSessionRoot(binding.adapterId, { ...environment, ...launchEnvironment });
  if (group === "task" && "taskId" in role) {
    return {
      scope: "task",
      taskId: args[2] as string,
      roleName: role.name,
      agentId: binding.agentId,
      adapterId: binding.adapterId,
      agentDefinitionUpdatedAt: agent.updatedAt,
      sessionRoot
    };
  }
  if (group === "role" && !("taskId" in role)) {
    return {
      scope: "global",
      roleName: role.name,
      agentId: binding.agentId,
      adapterId: binding.adapterId,
      agentDefinitionUpdatedAt: agent.updatedAt,
      sessionRoot
    };
  }
  return undefined;
}

function parseManualSessionRegistration(value: unknown): ManualSessionRegistration | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)) {
    return null;
  }
  const scope = descriptors.scope?.value;
  const required = scope === "task"
    ? ["scope", "taskId", "roleName", "agentId", "adapterId", "agentDefinitionUpdatedAt", "sessionRoot"]
    : scope === "global"
      ? ["scope", "roleName", "agentId", "adapterId", "agentDefinitionUpdatedAt", "sessionRoot"]
      : null;
  if (required === null || Object.keys(descriptors).length !== required.length ||
      required.some((key) => !Object.hasOwn(descriptors, key))) return null;
  if (required.slice(1).some((key) =>
    typeof descriptors[key]?.value !== "string" || descriptors[key].value.trim().length === 0
  )) return null;
  const sessionRoot = descriptors.sessionRoot.value as string;
  if (!isAbsolute(sessionRoot) || resolve(sessionRoot) !== sessionRoot) return null;
  if (scope === "task") {
    return {
      scope,
      taskId: descriptors.taskId.value as string,
      roleName: descriptors.roleName.value as string,
      agentId: descriptors.agentId.value as string,
      adapterId: descriptors.adapterId.value as string,
      agentDefinitionUpdatedAt: descriptors.agentDefinitionUpdatedAt.value as string,
      sessionRoot
    };
  }
  return {
    scope,
    roleName: descriptors.roleName.value as string,
    agentId: descriptors.agentId.value as string,
    adapterId: descriptors.adapterId.value as string,
    agentDefinitionUpdatedAt: descriptors.agentDefinitionUpdatedAt.value as string,
    sessionRoot
  };
}
