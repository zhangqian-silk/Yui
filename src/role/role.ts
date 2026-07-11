import type { RunnerDefinition, RunnerEnvironment } from "../runner/runner.js";

export type RoleStatus = "idle" | "running" | "detached" | "exited" | "failed";

export type RoleProfile = {
  description?: string;
  responsibilities?: string[];
  constraints?: string[];
  expectedOutput?: string;
  systemPrompt?: string;
  skills?: string[];
};

export type Role = RoleProfile & {
  schemaVersion: 1;
  name: string;
  agent: string;
  command: string;
  args: string[];
  env: RunnerEnvironment;
  workspace: string;
  status: RoleStatus;
  createdAt: string;
  updatedAt: string;
};

export type GlobalRole = RoleProfile & {
  schemaVersion: 1;
  name: string;
  agent: string;
  command: string;
  args: string[];
  env: RunnerEnvironment;
  workspace: string;
  createdAt: string;
  updatedAt: string;
};

export function createRole(
  name: string,
  runner: RunnerDefinition,
  workspace: string,
  now: Date,
  profile: RoleProfile = {}
): Role {
  const trimmedName = name.trim();
  const trimmedAgent = runner.id.trim();
  const trimmedWorkspace = workspace.trim();

  if (trimmedName.length === 0) {
    throw new Error("Role name is required.");
  }

  if (trimmedAgent.length === 0) {
    throw new Error("Role agent is required.");
  }

  if (trimmedWorkspace.length === 0) {
    throw new Error("Role workspace is required.");
  }

  const timestamp = now.toISOString();

  return {
    schemaVersion: 1,
    name: trimmedName,
    agent: trimmedAgent,
    command: runner.command,
    args: runner.args,
    env: runner.env,
    workspace: trimmedWorkspace,
    ...profile,
    status: "idle",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function createGlobalRole(
  name: string,
  runner: RunnerDefinition,
  workspace: string,
  now: Date,
  profile: RoleProfile = {}
): GlobalRole {
  const role = createRole(name, runner, workspace, now, profile);

  return {
    schemaVersion: role.schemaVersion,
    name: role.name,
    agent: role.agent,
    command: role.command,
    args: role.args,
    env: role.env,
    workspace: role.workspace,
    description: role.description,
    responsibilities: role.responsibilities,
    constraints: role.constraints,
    expectedOutput: role.expectedOutput,
    systemPrompt: role.systemPrompt,
    skills: role.skills,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt
  };
}

export function copyGlobalRoleToTaskRole(globalRole: GlobalRole, now: Date, name = globalRole.name): Role {
  const timestamp = now.toISOString();

  return {
    schemaVersion: 1,
    name,
    agent: globalRole.agent,
    command: globalRole.command,
    args: globalRole.args,
    env: globalRole.env,
    workspace: globalRole.workspace,
    description: globalRole.description,
    responsibilities: globalRole.responsibilities,
    constraints: globalRole.constraints,
    expectedOutput: globalRole.expectedOutput,
    systemPrompt: globalRole.systemPrompt,
    skills: globalRole.skills,
    status: "idle",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function updateGlobalRole(
  role: GlobalRole,
  patch: Partial<Pick<GlobalRole, "name" | "agent" | "command" | "args" | "env" | "workspace">>,
  now: Date
): GlobalRole {
  return {
    ...role,
    ...patch,
    updatedAt: now.toISOString()
  };
}

export function updateRoleStatus(role: Role, status: RoleStatus, now: Date): Role {
  return {
    ...role,
    status,
    updatedAt: now.toISOString()
  };
}

export function updateRole(role: Role, patch: Partial<Pick<Role, "name" | "agent" | "command" | "args" | "env" | "workspace">>, now: Date): Role {
  return {
    ...role,
    ...patch,
    updatedAt: now.toISOString()
  };
}
