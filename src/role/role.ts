import { isDeepStrictEqual } from "node:util";

import type { WorkerAccess } from "../profile/agentProfile.js";
import type {
  ClaudeRoleAgentConfig,
  CodexRoleAgentConfig,
  RoleAgentConfig
} from "../executor/agentAdapter.js";
import {
  defaultRoleAgentConfig,
  resolveAgentAdapter
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
  /** Monotonic desired configuration revision. It only affects the next launch. */
  launchRevision: number;
  /** Provider-neutral read/write behavior intent copied from the Profile. */
  defaultAccess: WorkerAccess;
  name: string;
  activeAgentId: string;
  agentBindings: Record<string, RoleAgentBinding>;
  workspace: string;
  createdAt: string;
  updatedAt: string;
};

export type GlobalRole = RoleAgentOwner & {
  schemaVersion: 3;
};
export type TaskRole = RoleAgentOwner & {
  schemaVersion: 4;
  taskId: string;
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
  const defaults = defaultRoleAgentConfig(adapterId);
  const effectiveConfig = config === undefined
    ? defaults
    : config.permission === undefined
      ? { ...config, permission: defaults.permission } as RoleAgentConfig
      : config;
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
  profile: RoleProfile = {},
  defaultAccess: WorkerAccess = "write"
): Role {
  const owner = createRoleOwner(name, bindings, activeAgentId, workspace, now, profile, defaultAccess);
  return validateTaskRole({
    ...owner,
    schemaVersion: 4,
    taskId: requireSafeIdentity(taskId, "Task id")
  });
}

export function createGlobalRole(
  name: string,
  bindings: readonly RoleAgentBinding[],
  activeAgentId: string,
  workspace: string,
  now: Date,
  profile: RoleProfile = {},
  defaultAccess: WorkerAccess = "write"
): GlobalRole {
  return validateGlobalRole({
    ...createRoleOwner(name, bindings, activeAgentId, workspace, now, profile, defaultAccess),
    schemaVersion: 3
  });
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
    schemaVersion: 4,
    launchRevision: 1,
    defaultAccess: globalRole.defaultAccess,
    taskId: requireSafeIdentity(taskId, "Task id"),
    name: requireSafeIdentity(name, "Role name"),
    activeAgentId: globalRole.activeAgentId,
    agentBindings: cloneBindings(globalRole.agentBindings),
    workspace: globalRole.workspace,
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
  patch: Partial<Pick<GlobalRole,
    "name" | "activeAgentId" | "agentBindings" | "workspace" | "defaultAccess">> & RoleProfile,
  now: Date
): GlobalRole {
  validateGlobalRole(role);
  const desiredBefore = desiredLaunchProjection(role);
  const updated = {
    ...role,
    ...cloneRolePatch(patch),
    updatedAt: now.toISOString()
  };
  clearProfileFields(updated, patch);
  updated.launchRevision = isDeepStrictEqual(desiredBefore, desiredLaunchProjection(updated))
    ? role.launchRevision
    : role.launchRevision + 1;
  return validateGlobalRole(updated);
}

export function updateRole(
  role: Role,
  patch: Partial<Pick<Role,
    "name" | "activeAgentId" | "agentBindings" | "workspace" | "defaultAccess">> & RoleProfile,
  now: Date
): Role {
  validateTaskRole(role);
  const desiredBefore = desiredLaunchProjection(role);
  const updated = {
    ...role,
    ...cloneRolePatch(patch),
    updatedAt: now.toISOString()
  };
  clearProfileFields(updated, patch);
  updated.launchRevision = isDeepStrictEqual(desiredBefore, desiredLaunchProjection(updated))
    ? role.launchRevision
    : role.launchRevision + 1;
  return validateTaskRole(updated);
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
  const normalizedTarget = requireSafeIdentity(targetAgentId, "Target Agent id");
  if (!Object.hasOwn(role.agentBindings, normalizedTarget)) {
    throw new Error(`Role Agent is not bound: ${normalizedTarget}.`);
  }
  assertSessionOwnerMatchesRole(role, sessions);

  const fromAgentId = role.activeAgentId;
  const mode = sessions.sessions[normalizedTarget] === undefined ? "new" : "resume";
  const timestamp = now.toISOString();
  const updatedRole = "taskId" in role
    ? updateRole(role, { activeAgentId: normalizedTarget }, now)
    : updateGlobalRole(role, { activeAgentId: normalizedTarget }, now);
  // A running process keeps its immutable effective identity. The desired
  // switch becomes visible only when the next launch is planned.
  const updatedSessions = runtime.activeRun || runtime.nativeProcessRunning
    ? sessions
    : {
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
    const taskSessions = sessions.owner.scope === "task"
      ? sessions as TaskRoleSessionSet
      : null;
    if (taskSessions?.inFlight?.agentId === normalizedAgentId) {
      throw new Error(`Cannot unbind Role Agent with an active Run: ${normalizedAgentId}.`);
    }
    const targetSession = sessions.sessions[normalizedAgentId];
    if (targetSession !== undefined && targetSession.status !== "stopped") {
      throw new Error(
        `Cannot unbind Role Agent while its native session is ${targetSession.status}: `
        + `${normalizedAgentId}.`
      );
    }
    const globalSessions = sessions.owner.scope === "global"
      ? sessions as GlobalRoleSessionSet
      : null;
    const targetHistory = globalSessions === null
      ? []
      : Object.entries(globalSessions.history ?? {}).filter(([, session]) => (
          session.agentId === normalizedAgentId
        ));
    const targetTaskHistory = (taskSessions?.history ?? []).filter((session) => (
      session.agentId === normalizedAgentId
    ));
    if (targetSession !== undefined || targetHistory.length > 0 || targetTaskHistory.length > 0) {
      const remainingSessions = { ...sessions.sessions };
      delete remainingSessions[normalizedAgentId];
      const remainingHistory = globalSessions === null
        ? undefined
        : Object.fromEntries(Object.entries(globalSessions.history ?? {}).filter(([, session]) => (
            session.agentId !== normalizedAgentId
          )));
      const remainingTaskHistory = taskSessions === null
        ? undefined
        : (taskSessions.history ?? []).filter((session) => (
            session.agentId !== normalizedAgentId
          ));
      updatedSessions = validateRoleSessionSet({
        ...sessions,
        sessions: remainingSessions,
        ...(remainingHistory === undefined ? {} : { history: remainingHistory }),
        ...(remainingTaskHistory === undefined ? {} : { history: remainingTaskHistory }),
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
  return validateRoleOwner(role);
}

function createRoleOwner(
  name: string,
  bindings: readonly RoleAgentBinding[],
  activeAgentId: string,
  workspace: string,
  now: Date,
  profile: RoleProfile,
  defaultAccess: WorkerAccess
): RoleAgentOwner {
  const mappedBindings: Record<string, RoleAgentBinding> = {};
  for (const sourceBinding of bindings) {
    const binding = validateRoleAgentBinding(cloneBinding(sourceBinding));
    if (Object.hasOwn(mappedBindings, binding.agentId)) {
      throw new Error(`Role Agent binding is duplicated: ${binding.agentId}.`);
    }
    mappedBindings[binding.agentId] = binding;
  }
  const timestamp = now.toISOString();
  return {
    ...cloneProfile(profile),
    launchRevision: 1,
    defaultAccess,
    name: requireSafeIdentity(name, "Role name"),
    activeAgentId: requireSafeIdentity(activeAgentId, "Role active Agent id"),
    agentBindings: mappedBindings,
    workspace: requireText(workspace, "Role workspace"),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function validateRoleOwner<T extends GlobalRole | TaskRole>(role: T): T {
  const expectedSchemaVersion = "taskId" in role ? 4 : 3;
  if (role.schemaVersion !== expectedSchemaVersion) {
    throw new Error("Role schema version is invalid.");
  }
  if (!Number.isSafeInteger(role.launchRevision) || role.launchRevision < 1) {
    throw new Error("Role launch revision must be a positive integer.");
  }
  if (role.defaultAccess !== "read" && role.defaultAccess !== "write") {
    throw new Error("Role default access is invalid.");
  }
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
  if (binding.config.permission === undefined) {
    throw new Error(`Role Agent binding requires an explicit permission strategy: ${agentId}.`);
  }
  resolveAgentAdapter(adapterId).canonicalizeConfig(binding.config as never);
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
  patch: Partial<Pick<GlobalRole,
    "name" | "activeAgentId" | "agentBindings" | "workspace" | "defaultAccess">> & RoleProfile
): typeof patch {
  return {
    ...(patch.name === undefined ? {} : { name: requireSafeIdentity(patch.name, "Role name") }),
    ...(patch.activeAgentId === undefined
      ? {}
      : { activeAgentId: requireSafeIdentity(patch.activeAgentId, "Role active Agent id") }),
    ...(patch.workspace === undefined ? {} : { workspace: requireText(patch.workspace, "Role workspace") }),
    ...(patch.defaultAccess === undefined ? {} : { defaultAccess: patch.defaultAccess }),
    ...(patch.agentBindings === undefined ? {} : { agentBindings: cloneBindings(patch.agentBindings) }),
    ...cloneProfile(patch)
  };
}

function desiredLaunchProjection(role: GlobalRole | TaskRole): unknown {
  return {
    name: role.name,
    activeAgentId: role.activeAgentId,
    agentBindings: role.agentBindings,
    workspace: role.workspace,
    defaultAccess: role.defaultAccess,
    ...cloneProfile(role)
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
