import { isAbsolute, resolve } from "node:path";
import type { AgentDefinition } from "../agent/agent.js";
import { validateAgentAdvancedArguments } from "../agent/argumentPolicy.js";
import type {
  GlobalRoleSessionSet,
  RoleSessionSet,
  TaskRoleSessionSet
} from "../executor/agentExecutor.js";

export type RoleStatus = "idle" | "running" | "detached" | "exited" | "failed";

export type RoleProfile = {
  description?: string;
  responsibilities?: string[];
  constraints?: string[];
  expectedOutput?: string;
  systemPrompt?: string;
  skills?: string[];
};

export type AdvancedAgentConfig = { rawArgs?: string[] };

export type CodexRoleAgentConfig = {
  adapterId: "codex";
  model?: string;
  effort?: string;
  permission?: {
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    approval?: "untrusted" | "on-request" | "never";
  };
  search?: boolean;
  profile?: string;
  additionalDirectories?: string[];
  advanced?: AdvancedAgentConfig;
};

export type ClaudeRoleAgentConfig = {
  adapterId: "claude";
  model?: string;
  effort?: string;
  permission?: {
    mode?: string;
    allowedTools?: string[];
    disallowedTools?: string[];
  };
  additionalDirectories?: string[];
  settingsFile?: string;
  settingsSources?: string[];
  advanced?: AdvancedAgentConfig;
};

export type RoleAgentConfig = CodexRoleAgentConfig | ClaudeRoleAgentConfig;

export type RoleAgentBinding = {
  agentId: string;
  adapterId: RoleAgentConfig["adapterId"];
  config: RoleAgentConfig;
};

export function createRoleAgentBinding(
  agent: AgentDefinition,
  config?: RoleAgentConfig
): RoleAgentBinding {
  const adapterId = requireSupportedAdapterId(agent.adapterId);
  const effectiveConfig: RoleAgentConfig = config ?? { adapterId };
  if (effectiveConfig.adapterId !== adapterId) {
    throw new Error(`Role Agent config adapter does not match AgentDefinition: ${agent.id}.`);
  }
  return validateRoleAgentBinding(cloneBinding({ agentId: agent.id, adapterId, config: effectiveConfig }));
}

type RoleAgentOwner = RoleProfile & {
  schemaVersion: 2;
  name: string;
  activeAgentId: string;
  agentBindings: Record<string, RoleAgentBinding>;
  workspace: string;
  createdAt: string;
  updatedAt: string;
};

export type GlobalRole = RoleAgentOwner;
export type TaskRole = RoleAgentOwner & { taskId: string; status: RoleStatus };
export type Role = TaskRole;

export function createRole(
  taskId: string,
  name: string,
  bindings: RoleAgentBinding[],
  activeAgentId: string,
  workspace: string,
  now: Date,
  profile: RoleProfile = {}
): Role {
  const core = createRoleOwner(name, bindings, activeAgentId, workspace, now, profile);
  return validateTaskRole({ ...core, taskId: requireSafeIdentity(taskId, "Task id"), status: "idle" });
}

export function createGlobalRole(
  name: string,
  bindings: RoleAgentBinding[],
  activeAgentId: string,
  workspace: string,
  now: Date,
  profile: RoleProfile = {}
): GlobalRole {
  return createRoleOwner(name, bindings, activeAgentId, workspace, now, profile);
}

export function copyGlobalRoleToTaskRole(globalRole: GlobalRole, taskId: string, now: Date, name = globalRole.name): Role {
  const timestamp = now.toISOString();
  return validateTaskRole({
    ...cloneProfile(globalRole),
    schemaVersion: 2,
    taskId: requireSafeIdentity(taskId, "Task id"),
    name: name.trim(),
    activeAgentId: globalRole.activeAgentId,
    agentBindings: cloneBindings(globalRole.agentBindings),
    workspace: globalRole.workspace,
    status: "idle",
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function activeRoleAgentBinding(role: Role | GlobalRole): RoleAgentBinding {
  if (!Object.hasOwn(role.agentBindings, role.activeAgentId)) {
    throw new Error(`Role active agent is not bound: ${role.activeAgentId}.`);
  }
  const binding = role.agentBindings[role.activeAgentId];
  return binding;
}

export function updateGlobalRole(
  role: GlobalRole,
  patch: Partial<Pick<GlobalRole, "name" | "activeAgentId" | "agentBindings" | "workspace">>,
  now: Date
): GlobalRole {
  return validateRoleOwner({ ...role, ...clonePatch(patch), updatedAt: now.toISOString() });
}

export function updateRoleStatus(role: Role, status: RoleStatus, now: Date): Role {
  return validateTaskRole({ ...role, status, updatedAt: now.toISOString() });
}

export function updateRole(
  role: Role,
  patch: Partial<Pick<Role, "name" | "activeAgentId" | "agentBindings" | "workspace">>,
  now: Date
): Role {
  return validateTaskRole({ ...role, ...clonePatch(patch), updatedAt: now.toISOString() });
}

export function switchActiveRoleAgent(
  role: Role,
  sessions: TaskRoleSessionSet,
  targetAgentId: string,
  runtime: { activeRun: boolean; nativeProcessRunning: boolean },
  now: Date
): {
  role: Role;
  sessions: TaskRoleSessionSet;
  mode: "new" | "resume";
  event: { type: "role.agent_switched"; payload: { fromAgentId: string; toAgentId: string; mode: "new" | "resume" } };
};
export function switchActiveRoleAgent(
  role: GlobalRole,
  sessions: GlobalRoleSessionSet,
  targetAgentId: string,
  runtime: { activeRun: boolean; nativeProcessRunning: boolean },
  now: Date
): {
  role: GlobalRole;
  sessions: GlobalRoleSessionSet;
  mode: "new" | "resume";
  event: { type: "role.agent_switched"; payload: { fromAgentId: string; toAgentId: string; mode: "new" | "resume" } };
};
export function switchActiveRoleAgent(
  role: Role | GlobalRole,
  sessions: RoleSessionSet,
  targetAgentId: string,
  runtime: { activeRun: boolean; nativeProcessRunning: boolean },
  now: Date
): {
  role: Role | GlobalRole;
  sessions: RoleSessionSet;
  mode: "new" | "resume";
  event: { type: "role.agent_switched"; payload: { fromAgentId: string; toAgentId: string; mode: "new" | "resume" } };
} {
  if (runtime.activeRun) {
    throw new Error("Cannot switch Role Agent while an active AgentRun exists.");
  }
  if (runtime.nativeProcessRunning) {
    throw new Error("Cannot switch Role Agent while the native Agent process is running.");
  }
  if (!Object.hasOwn(role.agentBindings, targetAgentId)) {
    throw new Error(`Role agent is not bound: ${targetAgentId}.`);
  }
  const ownerMatches = "taskId" in role
    ? sessions.owner.scope === "task" && sessions.owner.taskId === role.taskId && sessions.owner.roleName === role.name
    : sessions.owner.scope === "global" && sessions.owner.roleName === role.name;
  if (!ownerMatches) {
    throw new Error(`Role session owner does not match Role: ${role.name}.`);
  }
  if (sessions.activeAgentId !== role.activeAgentId) {
    throw new Error(`Role session active Agent does not match Role: ${role.name}.`);
  }
  const fromAgentId = role.activeAgentId;
  const mode = sessions.sessions[targetAgentId] === undefined ? "new" : "resume";
  return {
    role: "taskId" in role
      ? updateRole(role, { activeAgentId: targetAgentId }, now)
      : updateGlobalRole(role, { activeAgentId: targetAgentId }, now),
    sessions: { ...sessions, activeAgentId: targetAgentId, updatedAt: now.toISOString() },
    mode,
    event: { type: "role.agent_switched", payload: { fromAgentId, toAgentId: targetAgentId, mode } }
  };
}

function createRoleOwner(
  name: string,
  bindings: RoleAgentBinding[],
  activeAgentId: string,
  workspace: string,
  now: Date,
  profile: RoleProfile
): GlobalRole {
  const mappedBindings = Object.create(null) as Record<string, RoleAgentBinding>;
  for (const binding of bindings) {
    const cloned = validateRoleAgentBinding(cloneBinding(binding));
    if (Object.hasOwn(mappedBindings, cloned.agentId)) {
      throw new Error(`Role Agent binding is duplicated: ${cloned.agentId}.`);
    }
    mappedBindings[cloned.agentId] = cloned;
  }
  const timestamp = now.toISOString();
  return validateRoleOwner({
    ...cloneProfile(profile),
    schemaVersion: 2,
    name: name.trim(),
    activeAgentId: activeAgentId.trim(),
    agentBindings: mappedBindings,
    workspace: workspace.trim(),
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function validateRoleOwner<T extends GlobalRole>(role: T): T {
  requireSafeIdentity(role.name, "Role name");
  requireNonEmpty(role.workspace, "Role workspace");
  requireSafeIdentity(role.activeAgentId, "Role active Agent id");
  const entries = Object.entries(role.agentBindings);
  if (entries.length === 0) throw new Error("Role requires at least one Agent binding.");
  for (const [key, binding] of entries) {
    validateRoleAgentBinding(binding);
    if (key !== binding.agentId) {
      throw new Error(`Role Agent binding identity is inconsistent: ${key}.`);
    }
  }
  if (!Object.hasOwn(role.agentBindings, role.activeAgentId)) {
    throw new Error(`Role active agent is not bound: ${role.activeAgentId}.`);
  }
  return role;
}

function validateTaskRole<T extends TaskRole>(role: T): T {
  requireSafeIdentity(role.taskId, "Task id");
  return validateRoleOwner(role);
}

function validateRoleAgentBinding(binding: RoleAgentBinding): RoleAgentBinding {
  const agentId = requireSafeIdentity(binding.agentId, "Role Agent id");
  const adapterId = requireSupportedAdapterId(binding.adapterId);
  validateRoleAgentConfig(binding.config);
  if (agentId !== binding.agentId || adapterId !== binding.adapterId || binding.adapterId !== binding.config.adapterId) {
    throw new Error(`Role Agent binding identity is inconsistent: ${binding.agentId}.`);
  }
  return binding;
}

function validateRoleAgentConfig(config: RoleAgentConfig): void {
  if (config.adapterId === "codex") {
    assertExactKeys(config, [
      "adapterId", "model", "effort", "permission", "search", "profile",
      "additionalDirectories", "advanced"
    ], "Codex Role Agent config");
    validateOptionalString(config.model, "Codex model");
    validateOptionalString(config.effort, "Codex effort");
    validateOptionalString(config.profile, "Codex profile");
    if (config.search !== undefined && typeof config.search !== "boolean") {
      throw new Error("Codex search must be boolean.");
    }
    validateOptionalAbsolutePathArray(config.additionalDirectories, "Codex additional directory");
    if (config.permission !== undefined) {
      assertExactKeys(config.permission, ["sandbox", "approval"], "Codex permission config");
      validateOptionalString(config.permission.sandbox, "Codex sandbox");
      validateOptionalString(config.permission.approval, "Codex approval");
      if (config.permission.sandbox !== undefined &&
        !["read-only", "workspace-write", "danger-full-access"].includes(config.permission.sandbox)) {
        throw new Error("Codex sandbox is invalid.");
      }
      if (config.permission.approval !== undefined &&
        !["untrusted", "on-request", "never"].includes(config.permission.approval)) {
        throw new Error("Codex approval is invalid.");
      }
    }
    validateAdvancedConfig(config.advanced, config.adapterId);
    return;
  }

  assertExactKeys(config, [
    "adapterId", "model", "effort", "permission", "additionalDirectories",
    "settingsFile", "settingsSources", "advanced"
  ], "Claude Role Agent config");
  validateOptionalString(config.model, "Claude model");
  validateOptionalString(config.effort, "Claude effort");
  if (config.settingsFile !== undefined && !isSafeAbsolutePath(config.settingsFile)) {
    throw new Error("Claude settings file must be an absolute path.");
  }
  validateOptionalAbsolutePathArray(config.additionalDirectories, "Claude additional directory");
  if (config.settingsSources !== undefined) {
    validateOptionalStringArray(config.settingsSources, "Claude settings source");
    if (new Set(config.settingsSources).size !== config.settingsSources.length) {
      throw new Error("Claude settings sources contain duplicates.");
    }
  }
  if (config.permission !== undefined) {
    assertExactKeys(config.permission, ["mode", "allowedTools", "disallowedTools"], "Claude permission config");
    validateOptionalString(config.permission.mode, "Claude permission mode");
    validateOptionalStringArray(config.permission.allowedTools, "Claude allowed tool");
    validateOptionalStringArray(config.permission.disallowedTools, "Claude disallowed tool");
    validateSafeToolExpressions(config.permission.allowedTools);
    validateSafeToolExpressions(config.permission.disallowedTools);
  }
  validateAdvancedConfig(config.advanced, config.adapterId);
}

function validateAdvancedConfig(config: AdvancedAgentConfig | undefined, adapterId: RoleAgentConfig["adapterId"]): void {
  if (config === undefined) return;
  assertExactKeys(config, ["rawArgs"], "Advanced Role Agent config");
  validateOptionalStringArray(config.rawArgs, "Advanced Role Agent argument");
  validateAgentAdvancedArguments(adapterId, config.rawArgs ?? []);
}

function isSafeAbsolutePath(value: string): boolean {
  return isAbsolute(value) && resolve(value) === value && !/[\r\n\0{}]/.test(value);
}

function validateOptionalString(value: string | undefined, label: string): void {
  if (value === undefined) return;
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  requireNonEmpty(value, label);
}

function validateOptionalStringArray(values: string[] | undefined, label: string): void {
  if (values === undefined) return;
  if (!Array.isArray(values)) throw new Error(`${label} list must be an array.`);
  for (const value of values) {
    if (typeof value !== "string") throw new Error(`${label} must be a string.`);
    requireNonEmpty(value, label);
  }
}

function validateOptionalAbsolutePathArray(values: string[] | undefined, label: string): void {
  validateOptionalStringArray(values, label);
  for (const value of values ?? []) {
    if (!isSafeAbsolutePath(value)) throw new Error(`${label} must be an absolute path.`);
  }
}

function validateSafeToolExpressions(values: string[] | undefined): void {
  for (const value of values ?? []) {
    if (/(?:api[-_]?key|token|secret|password|credential|authorization|Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,})/i.test(value)) {
      throw new Error("Claude tool expressions cannot contain secret-bearing literals.");
    }
  }
}

function assertExactKeys(value: object, allowed: string[], label: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error(`${label} contains an unsupported field.`);
  }
}

function requireSupportedAdapterId(adapterId: string): RoleAgentConfig["adapterId"] {
  const normalized = requireNonEmpty(adapterId, "Role Agent adapter id");
  if (normalized !== "codex" && normalized !== "claude") {
    throw new Error(`Role Agent adapter is unsupported: ${normalized}.`);
  }
  return normalized;
}

function requireSafeIdentity(value: string, label: string): string {
  const normalized = requireNonEmpty(value, label);
  if (["__proto__", "prototype", "constructor"].includes(normalized) || /[\/\\\0]/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label} is required.`);
  return trimmed;
}

function cloneBindings(bindings: Record<string, RoleAgentBinding>): Record<string, RoleAgentBinding> {
  return Object.fromEntries(Object.entries(bindings).map(([key, binding]) => [key, cloneBinding(binding)]));
}

function cloneBinding(binding: RoleAgentBinding): RoleAgentBinding {
  return { ...binding, config: JSON.parse(JSON.stringify(binding.config)) as RoleAgentConfig };
}

function cloneProfile(profile: RoleProfile): RoleProfile {
  return {
    ...(profile.description === undefined ? {} : { description: profile.description }),
    ...(profile.responsibilities === undefined ? {} : { responsibilities: [...profile.responsibilities] }),
    ...(profile.constraints === undefined ? {} : { constraints: [...profile.constraints] }),
    ...(profile.expectedOutput === undefined ? {} : { expectedOutput: profile.expectedOutput }),
    ...(profile.systemPrompt === undefined ? {} : { systemPrompt: profile.systemPrompt }),
    ...(profile.skills === undefined ? {} : { skills: [...profile.skills] })
  };
}

function clonePatch<T extends Partial<Pick<GlobalRole, "name" | "activeAgentId" | "agentBindings" | "workspace">>>(patch: T): T {
  return {
    ...patch,
    ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
    ...(patch.activeAgentId === undefined ? {} : { activeAgentId: patch.activeAgentId.trim() }),
    ...(patch.workspace === undefined ? {} : { workspace: patch.workspace.trim() }),
    ...(patch.agentBindings === undefined ? {} : { agentBindings: cloneBindings(patch.agentBindings) })
  };
}
