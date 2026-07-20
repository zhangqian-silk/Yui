export type AgentSessionStatus = "reserved" | "ready" | "running" | "stopped" | "broken";

export type GlobalRoleSessionOwner = {
  scope: "global";
  roleName: string;
};

export type TaskRoleSessionOwner = {
  scope: "task";
  taskId: string;
  roleName: string;
};

export type RoleSessionOwner = GlobalRoleSessionOwner | TaskRoleSessionOwner;

/** One independently resumable native session for one Agent binding on a Role. */
export type RoleAgentSession = {
  schemaVersion: 1;
  agentId: string;
  adapterId: string;
  nativeSessionId: string;
  policy: "fixed" | "leader-controlled";
  status: AgentSessionStatus;
  createdAt: string;
  updatedAt: string;
};

type RoleSessionSetBase<TOwner extends RoleSessionOwner> = {
  schemaVersion: 1;
  owner: TOwner;
  activeAgentId: string;
  sessions: Record<string, RoleAgentSession>;
  updatedAt: string;
};

export type GlobalRoleSessionSet = RoleSessionSetBase<GlobalRoleSessionOwner>;
export type TaskRoleSessionSet = RoleSessionSetBase<TaskRoleSessionOwner>;
export type RoleSessionSet = GlobalRoleSessionSet | TaskRoleSessionSet;

export type ExecutorCapabilities = {
  recover: boolean;
  interrupt: boolean;
  nativeSessionDiscovery: boolean;
};

export type RecordRoleAgentSessionInput = {
  agentId: string;
  adapterId: string;
  nativeSessionId: string;
  policy: RoleAgentSession["policy"];
  status: AgentSessionStatus;
};

export function createRoleSessionSet(
  owner: GlobalRoleSessionOwner,
  activeAgentId: string,
  now: Date
): GlobalRoleSessionSet;
export function createRoleSessionSet(
  owner: TaskRoleSessionOwner,
  activeAgentId: string,
  now: Date
): TaskRoleSessionSet;
export function createRoleSessionSet(
  owner: RoleSessionOwner,
  activeAgentId: string,
  now: Date
): RoleSessionSet {
  return {
    schemaVersion: 1,
    owner: normalizeOwner(owner),
    activeAgentId: requireSafeIdentity(activeAgentId, "Active Agent id"),
    sessions: {},
    updatedAt: now.toISOString()
  } as RoleSessionSet;
}

export function activeRoleAgentSession(set: RoleSessionSet | null): RoleAgentSession | null {
  if (set === null) return null;
  validateRoleSessionSet(set);
  return set.sessions[set.activeAgentId] ?? null;
}

export function recordRoleAgentSession<TSet extends RoleSessionSet>(
  set: TSet,
  input: RecordRoleAgentSessionInput,
  now: Date
): TSet {
  validateRoleSessionSet(set);
  const agentId = requireSafeIdentity(input.agentId, "Agent id");
  const adapterId = requireText(input.adapterId, "Agent adapter id");
  const nativeSessionId = requireText(input.nativeSessionId, "Native session id");
  if (!isAgentSessionStatus(input.status)) {
    throw new Error(`Role Agent session status is invalid: ${input.status}.`);
  }
  if (input.policy !== "fixed" && input.policy !== "leader-controlled") {
    throw new Error(`Role Agent session policy is invalid: ${input.policy}.`);
  }
  const existing = set.sessions[agentId];
  if (existing !== undefined && existing.adapterId !== adapterId) {
    throw new Error(`Role Agent session adapter cannot change: ${agentId}.`);
  }
  const timestamp = now.toISOString();
  const session: RoleAgentSession = {
    schemaVersion: 1,
    agentId,
    adapterId,
    nativeSessionId,
    policy: input.policy,
    status: input.status,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
  validateRoleAgentSession(session, agentId);
  const updated = {
    ...set,
    sessions: { ...set.sessions, [agentId]: session },
    updatedAt: timestamp
  } as TSet;
  validateRoleSessionSet(updated);
  return updated;
}

export function createRoleAgentSession(
  input: RecordRoleAgentSessionInput,
  now: Date
): RoleAgentSession {
  const agentId = requireSafeIdentity(input.agentId, "Agent id");
  const set = createRoleSessionSet(
    { scope: "global", roleName: "session-factory" },
    agentId,
    now
  );
  return recordRoleAgentSession(set, input, now).sessions[agentId];
}

export function updateRoleAgentSessionStatus<TSet extends RoleSessionSet>(
  set: TSet,
  agentId: string,
  status: AgentSessionStatus,
  now: Date
): TSet {
  validateRoleSessionSet(set);
  const normalizedAgentId = requireSafeIdentity(agentId, "Agent id");
  if (!isAgentSessionStatus(status)) {
    throw new Error(`Role Agent session status is invalid: ${status}.`);
  }
  const existing = set.sessions[normalizedAgentId];
  if (existing === undefined) {
    throw new Error(`No Role session is recorded for Agent: ${normalizedAgentId}.`);
  }
  const timestamp = now.toISOString();
  const updated = {
    ...set,
    sessions: {
      ...set.sessions,
      [normalizedAgentId]: { ...existing, status, updatedAt: timestamp }
    },
    updatedAt: timestamp
  } as TSet;
  validateRoleSessionSet(updated);
  return updated;
}

export function roleAgentSessionResumeMode(
  set: RoleSessionSet | null,
  agentId: string
): "new" | "resume" {
  if (set === null) return "new";
  validateRoleSessionSet(set);
  const session = set.sessions[requireSafeIdentity(agentId, "Agent id")];
  return session === undefined ? "new" : "resume";
}

export function validateRoleSessionSet<TSet extends RoleSessionSet>(set: TSet): TSet {
  if (set.schemaVersion !== 1) throw new Error("Role session set schema version is invalid.");
  normalizeOwner(set.owner);
  requireSafeIdentity(set.activeAgentId, "Active Agent id");
  for (const [agentId, session] of Object.entries(set.sessions)) {
    validateRoleAgentSession(session, agentId);
  }
  requireText(set.updatedAt, "Role session set update timestamp");
  return set;
}

export function validateRoleAgentSession(
  session: RoleAgentSession,
  expectedAgentId = session.agentId
): RoleAgentSession {
  if (session.schemaVersion !== 1) {
    throw new Error(`Role Agent session schema version is invalid: ${expectedAgentId}.`);
  }
  const agentId = requireSafeIdentity(session.agentId, "Agent id");
  if (agentId !== expectedAgentId) {
    throw new Error(`Role Agent session identity is inconsistent: ${expectedAgentId}.`);
  }
  requireText(session.adapterId, "Agent adapter id");
  requireText(session.nativeSessionId, "Native session id");
  if (session.policy !== "fixed" && session.policy !== "leader-controlled") {
    throw new Error(`Role Agent session policy is invalid: ${agentId}.`);
  }
  if (!isAgentSessionStatus(session.status)) {
    throw new Error(`Role Agent session status is invalid: ${agentId}.`);
  }
  requireText(session.createdAt, "Role Agent session creation timestamp");
  requireText(session.updatedAt, "Role Agent session update timestamp");
  return session;
}

function normalizeOwner(owner: RoleSessionOwner): RoleSessionOwner {
  const roleName = requireSafeIdentity(owner.roleName, "Role name");
  return owner.scope === "global"
    ? { scope: "global", roleName }
    : {
        scope: "task",
        taskId: requireSafeIdentity(owner.taskId, "Task id"),
        roleName
      };
}

function isAgentSessionStatus(value: string): value is AgentSessionStatus {
  return ["reserved", "ready", "running", "stopped", "broken"].includes(value);
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
