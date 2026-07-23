import {
  hasRecentTurnId,
  rememberRecentTurnId,
  validatePendingTurnCompletion,
  validateRecentTurnIds,
  type PendingTurnCompletion
} from "./turnCompletion.js";

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
  schemaVersion: 2;
  agentId: string;
  adapterId: string;
  nativeSessionId: string;
  policy: "fixed" | "leader-controlled";
  status: AgentSessionStatus;
  recentCompletedTurnIds: readonly string[];
  createdAt: string;
  updatedAt: string;
};

type RoleSessionSetBase<TOwner extends RoleSessionOwner> = {
  schemaVersion: 2;
  owner: TOwner;
  activeAgentId: string;
  sessions: Record<string, RoleAgentSession>;
  updatedAt: string;
};

export type TaskRoleInFlight = Readonly<{
  agentId: string;
  runId: string;
  receiptId: string;
  preparedAt: string;
  deliveredAt?: string;
}>;

export type GlobalRoleSessionSet = RoleSessionSetBase<GlobalRoleSessionOwner>;
export type TaskRoleSessionSet = RoleSessionSetBase<TaskRoleSessionOwner> & {
  inFlight: TaskRoleInFlight | null;
  pendingTurnCompletion: PendingTurnCompletion | null;
};
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

export type TaskRoleRunFence = Readonly<{
  agentId: string;
  runId: string;
  receiptId: string;
}>;

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
  const base = {
    schemaVersion: 2 as const,
    owner: normalizeOwner(owner),
    activeAgentId: requireSafeIdentity(activeAgentId, "Active Agent id"),
    sessions: {},
    updatedAt: now.toISOString()
  };
  return owner.scope === "global"
    ? base as GlobalRoleSessionSet
    : {
        ...base,
        inFlight: null,
        pendingTurnCompletion: null
      } as TaskRoleSessionSet;
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
    schemaVersion: 2,
    agentId,
    adapterId,
    nativeSessionId,
    policy: input.policy,
    status: input.status,
    recentCompletedTurnIds: existing?.recentCompletedTurnIds ?? [],
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

export function rememberRoleAgentCompletedTurn<TSet extends RoleSessionSet>(
  set: TSet,
  agentId: string,
  nativeSessionId: string,
  turnId: string,
  now: Date
): TSet {
  validateRoleSessionSet(set);
  const normalizedAgentId = requireSafeIdentity(agentId, "Agent id");
  const session = set.sessions[normalizedAgentId];
  if (session === undefined) {
    throw new Error(`No Role session is recorded for Agent: ${normalizedAgentId}.`);
  }
  if (session.nativeSessionId !== requireText(nativeSessionId, "Native session id")) {
    throw new Error("Completed Turn native session does not match the Role Agent session.");
  }
  const normalizedTurnId = requireSafeIdentity(turnId, "Turn id");
  if (hasRecentTurnId(session.recentCompletedTurnIds, normalizedTurnId)) return set;
  const recentCompletedTurnIds = rememberRecentTurnId(
    session.recentCompletedTurnIds,
    normalizedTurnId
  );
  if (recentCompletedTurnIds === session.recentCompletedTurnIds) return set;
  const timestamp = requireDate(now, "Turn completedAt");
  const updated = {
    ...set,
    sessions: {
      ...set.sessions,
      [normalizedAgentId]: {
        ...session,
        status: "ready" as const,
        recentCompletedTurnIds,
        updatedAt: timestamp
      }
    },
    updatedAt: timestamp
  } as TSet;
  return validateRoleSessionSet(updated);
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

export function bindTaskRoleRun(
  set: TaskRoleSessionSet,
  fence: TaskRoleRunFence,
  preparedAt: Date
): TaskRoleSessionSet {
  validateRoleSessionSet(set);
  assertTaskRoleSessionSet(set);
  const normalized = normalizeTaskRoleRunFence(fence);
  if (normalized.agentId !== set.activeAgentId) {
    throw new Error("Task Role Run Agent does not match the active Agent.");
  }
  if (set.pendingTurnCompletion !== null) {
    throw new Error("Task Role session set has an unsettled Turn completion.");
  }
  if (set.inFlight !== null) {
    if (sameRunFence(set.inFlight, normalized)) return set;
    throw new Error("Task Role session set already has an in-flight Run.");
  }
  const timestamp = requireDate(preparedAt, "Task Role Run preparedAt");
  const updated: TaskRoleSessionSet = {
    ...set,
    inFlight: { ...normalized, preparedAt: timestamp },
    updatedAt: timestamp
  };
  return validateRoleSessionSet(updated);
}

export function markTaskRoleRunDelivered(
  set: TaskRoleSessionSet,
  fence: TaskRoleRunFence,
  deliveredAt: Date
): TaskRoleSessionSet {
  validateRoleSessionSet(set);
  assertTaskRoleSessionSet(set);
  const inFlight = requireMatchingInFlight(set, fence);
  if (inFlight.deliveredAt !== undefined) return set;
  const timestamp = requireDate(deliveredAt, "Task Role Run deliveredAt");
  if (Date.parse(timestamp) < Date.parse(inFlight.preparedAt)) {
    throw new Error("Task Role Run deliveredAt must not be earlier than preparedAt.");
  }
  const updated: TaskRoleSessionSet = {
    ...set,
    inFlight: { ...inFlight, deliveredAt: timestamp },
    updatedAt: timestamp
  };
  return validateRoleSessionSet(updated);
}

export function recordObservedTaskRoleCompletion(
  set: TaskRoleSessionSet,
  completion: PendingTurnCompletion
): TaskRoleSessionSet {
  validateRoleSessionSet(set);
  assertTaskRoleSessionSet(set);
  const observed = validatePendingTurnCompletion(completion);
  assertCompletionOwner(set, observed);
  const session = set.sessions[observed.agentId];
  if (session !== undefined && session.nativeSessionId !== observed.nativeSessionId) {
    throw new Error("Observed Turn native session does not match the Role Agent session.");
  }
  if (session?.recentCompletedTurnIds.includes(observed.turnId) === true) return set;
  if (set.pendingTurnCompletion !== null) {
    if (samePendingTurnCompletion(set.pendingTurnCompletion, observed)) return set;
    throw new Error("Task Role session set already has a pending Turn completion.");
  }
  const inFlight = set.inFlight;
  if (inFlight === null) {
    throw new Error("Observed Turn has no matching in-flight Run.");
  }
  if (inFlight.agentId !== observed.agentId || inFlight.runId !== observed.runId) {
    throw new Error("Observed Turn Run does not match the in-flight Run.");
  }
  if (inFlight.deliveredAt === undefined) {
    throw new Error("Observed Turn Run must be delivered before completion is recorded.");
  }
  const updated: TaskRoleSessionSet = {
    ...set,
    pendingTurnCompletion: observed,
    updatedAt: observed.observedAt
  };
  return validateRoleSessionSet(updated);
}

export function clearTaskRoleRun(
  set: TaskRoleSessionSet,
  fence: TaskRoleRunFence,
  clearedAt: Date
): TaskRoleSessionSet {
  validateRoleSessionSet(set);
  assertTaskRoleSessionSet(set);
  const inFlight = requireMatchingInFlight(set, fence);
  const timestamp = requireDate(clearedAt, "Task Role Run clearedAt");
  if (Date.parse(timestamp) < Date.parse(inFlight.preparedAt)) {
    throw new Error("Task Role Run clearedAt must not be earlier than preparedAt.");
  }
  const pending = set.pendingTurnCompletion;
  const session = set.sessions[inFlight.agentId];
  const sessions = pending !== null && session !== undefined
    ? {
        ...set.sessions,
        [inFlight.agentId]: {
          ...session,
          recentCompletedTurnIds: rememberRecentTurnId(
            session.recentCompletedTurnIds,
            pending.turnId
          ),
          updatedAt: timestamp
        }
      }
    : set.sessions;
  const updated: TaskRoleSessionSet = {
    ...set,
    sessions,
    inFlight: null,
    pendingTurnCompletion: null,
    updatedAt: timestamp
  };
  return validateRoleSessionSet(updated);
}

export function settleTaskRoleCompletion(
  set: TaskRoleSessionSet,
  expected: Readonly<{ agentId: string; runId: string; turnId: string }>,
  settledAt: Date
): TaskRoleSessionSet {
  validateRoleSessionSet(set);
  assertTaskRoleSessionSet(set);
  const agentId = requireSafeIdentity(expected.agentId, "Agent id");
  const runId = requireSafeIdentity(expected.runId, "Run id");
  const turnId = requireSafeIdentity(expected.turnId, "Turn id");
  const pending = set.pendingTurnCompletion;
  if (pending === null) throw new Error("Task Role session set has no pending Turn completion.");
  if (
    pending.agentId !== agentId
    || pending.runId !== runId
    || pending.turnId !== turnId
  ) {
    throw new Error("Pending Turn completion does not match the expected Turn.");
  }
  const inFlight = set.inFlight;
  if (inFlight === null || inFlight.agentId !== agentId || inFlight.runId !== runId) {
    throw new Error("Pending Turn completion does not match the in-flight Run.");
  }
  const session = set.sessions[agentId];
  if (session === undefined || session.nativeSessionId !== pending.nativeSessionId) {
    throw new Error("Pending Turn completion has no matching Role Agent native session.");
  }
  const timestamp = requireDate(settledAt, "Turn settledAt");
  if (Date.parse(timestamp) < Date.parse(pending.observedAt)) {
    throw new Error("Turn settledAt must not be earlier than observedAt.");
  }
  const updated: TaskRoleSessionSet = {
    ...set,
    sessions: {
      ...set.sessions,
      [agentId]: {
        ...session,
        recentCompletedTurnIds: rememberRecentTurnId(
          session.recentCompletedTurnIds,
          pending.turnId
        ),
        updatedAt: timestamp
      }
    },
    inFlight: null,
    pendingTurnCompletion: null,
    updatedAt: timestamp
  };
  return validateRoleSessionSet(updated);
}

export function validateRoleSessionSet<TSet extends RoleSessionSet>(set: TSet): TSet {
  if (set.schemaVersion !== 2) throw new Error("Role session set schema version is invalid.");
  normalizeOwner(set.owner);
  requireSafeIdentity(set.activeAgentId, "Active Agent id");
  for (const [agentId, session] of Object.entries(set.sessions)) {
    validateRoleAgentSession(session, agentId);
  }
  if (set.owner.scope === "global") {
    if (Object.hasOwn(set, "inFlight") || Object.hasOwn(set, "pendingTurnCompletion")) {
      throw new Error(
        "Global Role session set must not contain inFlight or pendingTurnCompletion."
      );
    }
  } else {
    if (!Object.hasOwn(set, "inFlight") || !Object.hasOwn(set, "pendingTurnCompletion")) {
      throw new Error("Task Role session set must contain its Turn fence.");
    }
    const taskSet = set as TaskRoleSessionSet;
    const inFlight = taskSet.inFlight === null
      ? null
      : validateTaskRoleInFlight(taskSet.inFlight);
    const pending = taskSet.pendingTurnCompletion === null
      ? null
      : validatePendingTurnCompletion(taskSet.pendingTurnCompletion);
    if (inFlight === null && pending !== null) {
      throw new Error("Pending Turn completion requires an in-flight Run.");
    }
    if (inFlight !== null && inFlight.agentId !== set.activeAgentId) {
      throw new Error("Task Role in-flight Run Agent must be active.");
    }
    if (pending !== null) {
      assertCompletionOwner(taskSet, pending);
      if (
        inFlight?.agentId !== pending.agentId
        || inFlight.runId !== pending.runId
        || inFlight.deliveredAt === undefined
      ) {
        throw new Error("Pending Turn completion must match a delivered in-flight Run.");
      }
      const session = taskSet.sessions[pending.agentId];
      if (session === undefined) {
        throw new Error("Pending Turn completion has no Role Agent session.");
      }
      if (session.nativeSessionId !== pending.nativeSessionId) {
        throw new Error("Pending Turn native session does not match the Role Agent session.");
      }
    }
  }
  requireText(set.updatedAt, "Role session set update timestamp");
  return set;
}

export function validateRoleAgentSession(
  session: RoleAgentSession,
  expectedAgentId = session.agentId
): RoleAgentSession {
  if (session.schemaVersion !== 2) {
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
  validateRecentTurnIds(session.recentCompletedTurnIds);
  requireText(session.createdAt, "Role Agent session creation timestamp");
  requireText(session.updatedAt, "Role Agent session update timestamp");
  return session;
}

function assertTaskRoleSessionSet(
  set: RoleSessionSet
): asserts set is TaskRoleSessionSet {
  if (set.owner.scope !== "task") {
    throw new Error("Turn fences require a Task Role session set.");
  }
}

function normalizeTaskRoleRunFence(fence: TaskRoleRunFence): TaskRoleRunFence {
  return {
    agentId: requireSafeIdentity(fence.agentId, "Agent id"),
    runId: requireSafeIdentity(fence.runId, "Run id"),
    receiptId: requireText(fence.receiptId, "Delivery receipt id")
  };
}

function requireMatchingInFlight(
  set: TaskRoleSessionSet,
  fence: TaskRoleRunFence
): TaskRoleInFlight {
  const normalized = normalizeTaskRoleRunFence(fence);
  const inFlight = set.inFlight;
  if (inFlight === null) throw new Error("Task Role session set has no in-flight Run.");
  if (inFlight.agentId !== normalized.agentId) {
    throw new Error("Task Role Run Agent does not match the in-flight Run.");
  }
  if (inFlight.runId !== normalized.runId) {
    throw new Error("Task Role Run does not match the in-flight Run.");
  }
  if (inFlight.receiptId !== normalized.receiptId) {
    throw new Error("Task Role Run receipt does not match the in-flight Run.");
  }
  return inFlight;
}

function validateTaskRoleInFlight(value: TaskRoleInFlight): TaskRoleInFlight {
  const fields = Object.keys(value);
  const unknown = fields.find(
    (field) => !["agentId", "runId", "receiptId", "preparedAt", "deliveredAt"].includes(field)
  );
  if (unknown !== undefined) {
    throw new Error(`Task Role in-flight Run has unknown field: ${unknown}.`);
  }
  for (const required of ["agentId", "runId", "receiptId", "preparedAt"]) {
    if (!Object.hasOwn(value, required)) {
      throw new Error(`Task Role in-flight Run is missing field: ${required}.`);
    }
  }
  const preparedAt = requirePersistedTimestamp(value.preparedAt, "Task Role Run preparedAt");
  if (value.deliveredAt !== undefined) {
    const deliveredAt = requirePersistedTimestamp(
      value.deliveredAt,
      "Task Role Run deliveredAt"
    );
    if (Date.parse(deliveredAt) < Date.parse(preparedAt)) {
      throw new Error("Task Role Run deliveredAt must not be earlier than preparedAt.");
    }
  }
  requireSafeIdentity(value.agentId, "Agent id");
  requireSafeIdentity(value.runId, "Run id");
  requireText(value.receiptId, "Delivery receipt id");
  return value;
}

function assertCompletionOwner(
  set: TaskRoleSessionSet,
  completion: PendingTurnCompletion
): void {
  if (completion.taskId !== set.owner.taskId) {
    throw new Error("Observed Turn Task does not match the Task Role session set.");
  }
  if (completion.roleName !== set.owner.roleName) {
    throw new Error("Observed Turn Role does not match the Task Role session set.");
  }
  if (completion.agentId !== set.activeAgentId) {
    throw new Error("Observed Turn Agent does not match the active Agent.");
  }
}

function sameRunFence(
  inFlight: TaskRoleInFlight,
  fence: TaskRoleRunFence
): boolean {
  return inFlight.agentId === fence.agentId
    && inFlight.runId === fence.runId
    && inFlight.receiptId === fence.receiptId;
}

function samePendingTurnCompletion(
  left: PendingTurnCompletion,
  right: PendingTurnCompletion
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireDate(value: Date, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label} must be a valid date.`);
  }
  return value.toISOString();
}

function requirePersistedTimestamp(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${label} must be a canonical timestamp.`);
  }
  return value;
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
