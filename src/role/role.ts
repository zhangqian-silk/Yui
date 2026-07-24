import type {
  ClaudeRoleAgentConfig,
  CodexRoleAgentConfig,
  RoleAgentConfig
} from "../executor/agentAdapter.js";
import {
  validateRoleSessionSet,
  type GlobalRoleSessionSet,
  type RoleSessionSet,
  type TaskRoleSessionSet
} from "../executor/agentExecutor.js";

export type {
  ClaudeRoleAgentConfig,
  CodexRoleAgentConfig,
  RoleAgentConfig
} from "../executor/agentAdapter.js";

export type RoleStatus = "idle" | "running" | "detached" | "exited" | "failed";

export type RoleProfile = {
  description?: string;
  responsibilities?: string[];
  constraints?: string[];
  expectedOutput?: string;
  systemPrompt?: string;
  skills?: string[];
};

export type RoleAgentBinding = {
  agentId: string;
  adapterId: RoleAgentConfig["adapterId"];
  config: RoleAgentConfig;
};

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
export type TaskRole = RoleAgentOwner & {
  taskId: string;
  status: RoleStatus;
};
export type Role = TaskRole;

export type AgentSwitchRuntime = {
  activeRun: boolean;
  nativeProcessRunning: boolean;
};

export type RoleAgentSwitchEvent = {
  type: "role.agent_switched";
  payload: {
    fromAgentId: string;
    toAgentId: string;
    mode: "new" | "resume";
  };
};

export function createRoleAgentBinding(
  agent: { id: string; adapterId: string },
  config?: RoleAgentConfig
): RoleAgentBinding {
  const agentId = requireSafeIdentity(agent.id, "Role Agent id");
  const adapterId = requireSupportedAdapterId(agent.adapterId);
  const effectiveConfig = config ?? { adapterId };
  if (effectiveConfig.adapterId !== adapterId) {
    throw new Error(`Role Agent config adapter does not match Agent: ${agentId}.`);
  }
  return cloneBinding({ agentId, adapterId, config: effectiveConfig });
}

export function createRole(
  taskId: string,
  name: string,
  bindings: readonly RoleAgentBinding[],
  activeAgentId: string,
  workspace: string,
  now: Date,
  profile: RoleProfile = {}
): Role {
  const owner = createRoleOwner(name, bindings, activeAgentId, workspace, now, profile);
  return validateTaskRole({
    ...owner,
    taskId: requireSafeIdentity(taskId, "Task id"),
    status: "idle"
  });
}

export function createGlobalRole(
  name: string,
  bindings: readonly RoleAgentBinding[],
  activeAgentId: string,
  workspace: string,
  now: Date,
  profile: RoleProfile = {}
): GlobalRole {
  return createRoleOwner(name, bindings, activeAgentId, workspace, now, profile);
}

export function copyGlobalRoleToTaskRole(
  globalRole: GlobalRole,
  taskId: string,
  now: Date,
  name = globalRole.name
): Role {
  validateGlobalRole(globalRole);
  const timestamp = now.toISOString();
  return validateTaskRole({
    ...cloneProfile(globalRole),
    schemaVersion: 2,
    taskId: requireSafeIdentity(taskId, "Task id"),
    name: requireSafeIdentity(name, "Role name"),
    activeAgentId: globalRole.activeAgentId,
    agentBindings: cloneBindings(globalRole.agentBindings),
    workspace: globalRole.workspace,
    status: "idle",
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function activeRoleAgentBinding(role: Role | GlobalRole): RoleAgentBinding {
  validateRoleOwner(role);
  return role.agentBindings[role.activeAgentId];
}

export function updateGlobalRole(
  role: GlobalRole,
  patch: Partial<Pick<GlobalRole, "name" | "activeAgentId" | "agentBindings" | "workspace">> & RoleProfile,
  now: Date
): GlobalRole {
  validateGlobalRole(role);
  const updated = {
    ...role,
    ...cloneRolePatch(patch),
    updatedAt: now.toISOString()
  };
  clearProfileFields(updated, patch);
  return validateGlobalRole(updated);
}

export function updateRole(
  role: Role,
  patch: Partial<Pick<Role, "name" | "activeAgentId" | "agentBindings" | "workspace">> & RoleProfile,
  now: Date
): Role {
  validateTaskRole(role);
  const updated = {
    ...role,
    ...cloneRolePatch(patch),
    updatedAt: now.toISOString()
  };
  clearProfileFields(updated, patch);
  return validateTaskRole(updated);
}

export function updateRoleStatus(role: Role, status: RoleStatus, now: Date): Role {
  validateTaskRole(role);
  if (!isRoleStatus(status)) throw new Error(`Role status is invalid: ${status}.`);
  return { ...role, status, updatedAt: now.toISOString() };
}

export function switchActiveRoleAgent(
  role: Role,
  sessions: TaskRoleSessionSet,
  targetAgentId: string,
  runtime: AgentSwitchRuntime,
  now: Date
): {
  role: Role;
  sessions: TaskRoleSessionSet;
  mode: "new" | "resume";
  event: RoleAgentSwitchEvent;
};
export function switchActiveRoleAgent(
  role: GlobalRole,
  sessions: GlobalRoleSessionSet,
  targetAgentId: string,
  runtime: AgentSwitchRuntime,
  now: Date
): {
  role: GlobalRole;
  sessions: GlobalRoleSessionSet;
  mode: "new" | "resume";
  event: RoleAgentSwitchEvent;
};
export function switchActiveRoleAgent(
  role: Role | GlobalRole,
  sessions: RoleSessionSet,
  targetAgentId: string,
  runtime: AgentSwitchRuntime,
  now: Date
): {
  role: Role | GlobalRole;
  sessions: RoleSessionSet;
  mode: "new" | "resume";
  event: RoleAgentSwitchEvent;
} {
  validateRoleOwner(role);
  if (runtime.activeRun) {
    throw new Error("Cannot switch Role Agent while an active AgentRun exists.");
  }
  if (runtime.nativeProcessRunning) {
    throw new Error("Cannot switch Role Agent while the native Agent process is running.");
  }
  const normalizedTarget = requireSafeIdentity(targetAgentId, "Target Agent id");
  if (!Object.hasOwn(role.agentBindings, normalizedTarget)) {
    throw new Error(`Role Agent is not bound: ${normalizedTarget}.`);
  }
  assertSessionOwnerMatchesRole(role, sessions);
  if (sessions.activeAgentId !== role.activeAgentId) {
    throw new Error(`Role session active Agent does not match Role: ${role.name}.`);
  }

  const fromAgentId = role.activeAgentId;
  const mode = sessions.sessions[normalizedTarget] === undefined ? "new" : "resume";
  const timestamp = now.toISOString();
  const updatedRole = "taskId" in role
    ? updateRole(role, { activeAgentId: normalizedTarget }, now)
    : updateGlobalRole(role, { activeAgentId: normalizedTarget }, now);
  const updatedSessions = {
    ...sessions,
    activeAgentId: normalizedTarget,
    updatedAt: timestamp
  } as RoleSessionSet;

  return {
    role: updatedRole,
    sessions: updatedSessions,
    mode,
    event: {
      type: "role.agent_switched",
      payload: { fromAgentId, toAgentId: normalizedTarget, mode }
    }
  };
}

export function unbindRoleAgent(
  role: Role,
  sessions: TaskRoleSessionSet | null,
  agentId: string,
  now: Date
): { role: Role; sessions: TaskRoleSessionSet | null };
export function unbindRoleAgent(
  role: GlobalRole,
  sessions: GlobalRoleSessionSet | null,
  agentId: string,
  now: Date
): { role: GlobalRole; sessions: GlobalRoleSessionSet | null };
export function unbindRoleAgent(
  role: Role | GlobalRole,
  sessions: RoleSessionSet | null,
  agentId: string,
  now: Date
): {
  role: Role | GlobalRole;
  sessions: RoleSessionSet | null;
} {
  validateRoleOwner(role);
  const normalizedAgentId = requireSafeIdentity(agentId, "Role Agent id");
  if (normalizedAgentId === role.activeAgentId) {
    throw new Error(`Cannot unbind active Role Agent: ${normalizedAgentId}.`);
  }
  if (!Object.hasOwn(role.agentBindings, normalizedAgentId)) {
    throw new Error(`Role Agent is not bound: ${normalizedAgentId}.`);
  }

  let updatedSessions = sessions;
  if (sessions !== null) {
    validateRoleSessionSet(sessions);
    assertSessionOwnerMatchesRole(role, sessions);
    if (sessions.activeAgentId !== role.activeAgentId) {
      throw new Error(`Role session active Agent does not match Role: ${role.name}.`);
    }
    const targetSession = sessions.sessions[normalizedAgentId];
    if (targetSession !== undefined && targetSession.status !== "stopped") {
      throw new Error(
        `Cannot unbind Role Agent while its native session is ${targetSession.status}: `
        + `${normalizedAgentId}.`
      );
    }
    if (targetSession !== undefined) {
      const remainingSessions = { ...sessions.sessions };
      delete remainingSessions[normalizedAgentId];
      updatedSessions = validateRoleSessionSet({
        ...sessions,
        sessions: remainingSessions,
        updatedAt: now.toISOString()
      } as RoleSessionSet);
    }
  }

  const remainingBindings = { ...role.agentBindings };
  delete remainingBindings[normalizedAgentId];
  const updatedRole = "taskId" in role
    ? updateRole(role, { agentBindings: remainingBindings }, now)
    : updateGlobalRole(role, { agentBindings: remainingBindings }, now);
  return { role: updatedRole, sessions: updatedSessions };
}

export function validateGlobalRole(role: GlobalRole): GlobalRole {
  return validateRoleOwner(role);
}

export function validateTaskRole(role: TaskRole): TaskRole {
  requireSafeIdentity(role.taskId, "Task id");
  if (!isRoleStatus(role.status)) throw new Error(`Role status is invalid: ${role.status}.`);
  return validateRoleOwner(role);
}

function createRoleOwner(
  name: string,
  bindings: readonly RoleAgentBinding[],
  activeAgentId: string,
  workspace: string,
  now: Date,
  profile: RoleProfile
): GlobalRole {
  const mappedBindings: Record<string, RoleAgentBinding> = {};
  for (const sourceBinding of bindings) {
    const binding = validateRoleAgentBinding(cloneBinding(sourceBinding));
    if (Object.hasOwn(mappedBindings, binding.agentId)) {
      throw new Error(`Role Agent binding is duplicated: ${binding.agentId}.`);
    }
    mappedBindings[binding.agentId] = binding;
  }
  const timestamp = now.toISOString();
  return validateGlobalRole({
    ...cloneProfile(profile),
    schemaVersion: 2,
    name: requireSafeIdentity(name, "Role name"),
    activeAgentId: requireSafeIdentity(activeAgentId, "Role active Agent id"),
    agentBindings: mappedBindings,
    workspace: requireText(workspace, "Role workspace"),
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function validateRoleOwner<T extends GlobalRole>(role: T): T {
  if (role.schemaVersion !== 2) throw new Error("Role schema version is invalid.");
  requireSafeIdentity(role.name, "Role name");
  requireSafeIdentity(role.activeAgentId, "Role active Agent id");
  requireText(role.workspace, "Role workspace");
  const entries = Object.entries(role.agentBindings);
  if (entries.length === 0) throw new Error("Role requires at least one Agent binding.");
  for (const [agentId, binding] of entries) {
    validateRoleAgentBinding(binding);
    if (agentId !== binding.agentId) {
      throw new Error(`Role Agent binding identity is inconsistent: ${agentId}.`);
    }
  }
  if (!Object.hasOwn(role.agentBindings, role.activeAgentId)) {
    throw new Error(`Role active Agent is not bound: ${role.activeAgentId}.`);
  }
  return role;
}

function validateRoleAgentBinding(binding: RoleAgentBinding): RoleAgentBinding {
  const agentId = requireSafeIdentity(binding.agentId, "Role Agent id");
  const adapterId = requireSupportedAdapterId(binding.adapterId);
  if (binding.config === null || typeof binding.config !== "object" || Array.isArray(binding.config)) {
    throw new Error(`Role Agent config is invalid: ${agentId}.`);
  }
  if (binding.config.adapterId !== adapterId) {
    throw new Error(`Role Agent binding adapter is inconsistent: ${agentId}.`);
  }
  return binding;
}

function assertSessionOwnerMatchesRole(role: Role | GlobalRole, sessions: RoleSessionSet): void {
  const matches = "taskId" in role
    ? sessions.owner.scope === "task"
      && sessions.owner.taskId === role.taskId
      && sessions.owner.roleName === role.name
    : sessions.owner.scope === "global" && sessions.owner.roleName === role.name;
  if (!matches) throw new Error(`Role session owner does not match Role: ${role.name}.`);
}

function cloneRolePatch(
  patch: Partial<Pick<GlobalRole, "name" | "activeAgentId" | "agentBindings" | "workspace">> & RoleProfile
): typeof patch {
  return {
    ...(patch.name === undefined ? {} : { name: requireSafeIdentity(patch.name, "Role name") }),
    ...(patch.activeAgentId === undefined
      ? {}
      : { activeAgentId: requireSafeIdentity(patch.activeAgentId, "Role active Agent id") }),
    ...(patch.workspace === undefined ? {} : { workspace: requireText(patch.workspace, "Role workspace") }),
    ...(patch.agentBindings === undefined ? {} : { agentBindings: cloneBindings(patch.agentBindings) }),
    ...cloneProfile(patch)
  };
}

function cloneBindings(bindings: Record<string, RoleAgentBinding>): Record<string, RoleAgentBinding> {
  return Object.fromEntries(
    Object.entries(bindings).map(([agentId, binding]) => [agentId, cloneBinding(binding)])
  );
}

function cloneBinding(binding: RoleAgentBinding): RoleAgentBinding {
  return {
    agentId: binding.agentId,
    adapterId: binding.adapterId,
    config: cloneJson(binding.config)
  };
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

function clearProfileFields(role: RoleProfile, patch: RoleProfile): void {
  for (const key of [
    "description",
    "responsibilities",
    "constraints",
    "expectedOutput",
    "systemPrompt",
    "skills"
  ] as const) {
    if (Object.hasOwn(patch, key) && patch[key] === undefined) delete role[key];
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requireSupportedAdapterId(value: string): RoleAgentConfig["adapterId"] {
  const normalized = requireText(value, "Role Agent adapter id");
  if (normalized !== "codex" && normalized !== "claude") {
    throw new Error(`Role Agent adapter is unsupported: ${normalized}.`);
  }
  return normalized;
}

function requireSafeIdentity(value: string, label: string): string {
  const normalized = requireText(value, label);
  if (["__proto__", "prototype", "constructor", ".", ".."].includes(normalized)
    || /[\/\\\0]/.test(normalized)) {
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

function isRoleStatus(value: string): value is RoleStatus {
  return ["idle", "running", "detached", "exited", "failed"].includes(value);
}
