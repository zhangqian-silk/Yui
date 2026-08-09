import { createHash } from "node:crypto";

import {
  hasRecentTurnId,
  rememberRecentTurnId,
  validatePendingTurnCompletion,
  validateRecentTurnIds,
  type PendingTurnCompletion
} from "./turnCompletion.js";
import {
  effectiveLaunchSnapshotsCompatible,
  validateEffectiveLaunchSnapshot,
  type EffectiveLaunchSnapshot
} from "./effectiveLaunch.js";

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
  schemaVersion: 3;
  agentId: string;
  adapterId: string;
  nativeSessionId: string;
  /** Durable exact generation identity for native lifecycle events. */
  launchId?: string;
  title?: string;
  preview?: string;
  policy: "fixed" | "leader-controlled";
  /** Immutable actual configuration for this native session. */
  effective: EffectiveLaunchSnapshot;
  status: AgentSessionStatus;
  recentCompletedTurnIds: readonly string[];
  createdAt: string;
  updatedAt: string;
};

type RoleSessionSetBase<TOwner extends RoleSessionOwner> = {
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
  /** Transport receipt observed; this does not prove provider acceptance. */
  pushedAt?: string;
  /** Exact provider acceptance boundary. */
  deliveredAt?: string;
}>;

export type GlobalRoleSessionSet = RoleSessionSetBase<GlobalRoleSessionOwner> & {
  schemaVersion: 3;
  /** Immutable terminal native Sessions keyed by an opaque Yui reference. */
  history?: Record<string, RoleAgentSession>;
};

export type TaskRoleSessionSet = RoleSessionSetBase<TaskRoleSessionOwner> & {
  schemaVersion: 4;
  /** Immutable terminal native Sessions superseded by a fresh effective launch. */
  history?: readonly RoleAgentSession[];
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
  launchId?: string;
  title?: string;
  preview?: string;
  policy: RoleAgentSession["policy"];
  status: AgentSessionStatus;
  effective: EffectiveLaunchSnapshot;
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
    owner: normalizeOwner(owner),
    activeAgentId: requireSafeIdentity(activeAgentId, "Active Agent id"),
    sessions: {},
    updatedAt: now.toISOString()
  };
  return owner.scope === "global"
    ? { ...base, schemaVersion: 3 } as GlobalRoleSessionSet
    : {
        ...base,
        schemaVersion: 4,
        inFlight: null,
        pendingTurnCompletion: null
      } as TaskRoleSessionSet;
}

export function activeRoleAgentSession(set: RoleSessionSet | null): RoleAgentSession | null {
  if (set === null) return null;
  validateRoleSessionSet(set);
  return set.sessions[set.activeAgentId] ?? null;
}

/** The immutable snapshot that remains actual until its native process terminates. */
export function activeLiveRoleAgentSession(set: RoleSessionSet | null): RoleAgentSession | null {
  const session = activeRoleAgentSession(set);
  return session === null || session.status === "stopped" || session.status === "broken"
    ? null
    : session;
}

export function roleAgentSessionRef(session: Readonly<{
  agentId: string;
  adapterId: string;
  nativeSessionId: string;
}>): string {
  const digest = createHash("sha256").update(JSON.stringify([
    requireText(session.agentId, "Agent id"),
    requireText(session.adapterId, "Agent adapter id"),
    requireText(session.nativeSessionId, "Native session id")
  ])).digest("hex");
  return `op-${digest.slice(0, 16)}`;
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
  if (set.owner.scope === "task") {
    const historical = ((set as TaskRoleSessionSet).history ?? []).find((entry) => (
      entry.nativeSessionId === nativeSessionId
      || (input.launchId !== undefined && entry.launchId === input.launchId)
    ));
    if (historical !== undefined) {
      throw new Error("A new Task Role Session cannot reuse a historical native identity.");
    }
  }
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
  const effective = validateEffectiveLaunchSnapshot(input.effective);
  if (effective.agentId !== agentId || effective.adapterId !== adapterId) {
    throw new Error(`Role Agent session effective identity is inconsistent: ${agentId}.`);
  }
  if (existing !== undefined && existing.nativeSessionId === nativeSessionId
    && !effectiveLaunchSnapshotsCompatible(existing.effective, effective)) {
    throw new Error(`Role Agent session effective launch cannot change: ${agentId}.`);
  }
  if (existing !== undefined && existing.nativeSessionId !== nativeSessionId
    && existing.status !== "stopped" && existing.status !== "broken") {
    throw new Error(`Live Role Agent native session cannot be replaced: ${agentId}.`);
  }
  const timestamp = now.toISOString();
  const continuing = existing?.nativeSessionId === nativeSessionId ? existing : undefined;
  const session: RoleAgentSession = {
    schemaVersion: 3,
    agentId,
    adapterId,
    nativeSessionId,
    ...(input.launchId === undefined
      ? continuing?.launchId === undefined ? {} : { launchId: continuing.launchId }
      : { launchId: requireText(input.launchId, "Launch id") }),
    ...optionalSessionText("title", input.title ?? continuing?.title),
    ...optionalSessionText("preview", input.preview ?? continuing?.preview),
    policy: input.policy,
    effective: continuing?.effective ?? effective,
    status: input.status,
    recentCompletedTurnIds: continuing?.recentCompletedTurnIds ?? [],
    createdAt: continuing?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
  validateRoleAgentSession(session, agentId);
  const taskHistory = set.owner.scope === "task"
    && existing !== undefined
    && continuing === undefined
    ? [...((set as TaskRoleSessionSet).history ?? []), existing]
    : undefined;
  const globalHistory = set.owner.scope === "global"
    && existing !== undefined
    && continuing === undefined
    ? {
        ...((set as GlobalRoleSessionSet).history ?? {}),
        [roleAgentSessionRef(existing)]: existing
      }
    : undefined;
  const updated = {
    ...set,
    activeAgentId: agentId,
    sessions: { ...set.sessions, [agentId]: session },
    ...(taskHistory === undefined ? {} : { history: taskHistory }),
    ...(globalHistory === undefined ? {} : { history: globalHistory }),
    updatedAt: timestamp
  } as TSet;
  validateRoleSessionSet(updated);
  return updated;
}

/**
 * Session titles and previews can originate in native Agent output. Keep them
 * single-line and inert before they are persisted or rendered in a terminal.
 */
export function normalizeRoleAgentSessionText(value: string): string {
  return value
    .replaceAll(/\u001B\][^\u0007]*(?:\u0007|\u001B\\|\u009C)/gu, " ")
    .replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, " ")
    .replaceAll(/[\u0000-\u001F\u007F-\u009F]/gu, " ")
    .trim()
    .replaceAll(/\s+/gu, " ");
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

export function retireTaskRoleSessionsForWorkspace(
  set: TaskRoleSessionSet,
  now: Date
): TaskRoleSessionSet {
  validateRoleSessionSet(set);
  if (
    set.inFlight !== null
    || set.pendingTurnCompletion !== null
  ) {
    throw new Error("Cannot retire a Task Role session with unsettled Run state.");
  }
  const live = Object.values(set.sessions).find(
    ({ status }) => status !== "stopped" && status !== "broken"
  );
  if (live !== undefined) {
    throw new Error(
      `Task Role session must be stopped before workspace migration: ${live.agentId}.`
    );
  }
  const timestamp = now.toISOString();
  return validateRoleSessionSet({
    ...set,
    // Native sessions may be scoped to their launch cwd. Every binding must
    // receive a fresh identity after the Role workspace changes.
    history: [...(set.history ?? []), ...Object.values(set.sessions)],
    sessions: {},
    updatedAt: timestamp
  });
}

/**
 * Terminalizes only the aggregate-16 Claude placeholder shape after the
 * caller has fenced the Task store and proved that the exact Role has no live
 * native pane. All other nonterminal durable Sessions remain blockers for the
 * ordinary workspace-retirement path above.
 */
export function retireConfirmedAbsentInactiveTaskRolePlaceholders(
  set: TaskRoleSessionSet,
  now: Date
): TaskRoleSessionSet {
  validateRoleSessionSet(set);
  if (set.inFlight !== null || set.pendingTurnCompletion !== null) {
    throw new Error("Cannot retire a Task Role placeholder with unsettled Run state.");
  }
  const timestamp = now.toISOString();
  let changed = false;
  const sessions = Object.fromEntries(Object.entries(set.sessions).map(([agentId, session]) => {
    const isNeverStartedInactiveClaude = agentId !== set.activeAgentId
      && session.adapterId === "claude"
      && (session.status === "reserved" || session.status === "ready")
      && session.launchId === undefined
      && session.recentCompletedTurnIds.length === 0;
    if (!isNeverStartedInactiveClaude) return [agentId, session];
    changed = true;
    return [agentId, { ...session, status: "broken" as const, updatedAt: timestamp }];
  }));
  if (!changed) return set;
  return validateRoleSessionSet({
    ...set,
    sessions,
    updatedAt: timestamp
  });
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
        status: session.status === "stopped" || session.status === "broken"
          ? session.status
          : "ready" as const,
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
  agentId: string,
  desired: EffectiveLaunchSnapshot
): "new" | "resume" {
  if (set === null) return "new";
  validateRoleSessionSet(set);
  const session = set.sessions[requireSafeIdentity(agentId, "Agent id")];
  if (session === undefined || session.nativeSessionId.trim().length === 0) return "new";
  if (effectiveLaunchSnapshotsCompatible(session.effective, desired)) return "resume";
  if (session.status !== "stopped" && session.status !== "broken") {
    throw new Error(
      `Role Agent session is incompatible with the next effective launch: ${agentId}. `
      + "Stop the existing native process before starting a fresh Session."
    );
  }
  return "new";
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

export function markTaskRoleRunPushed(
  set: TaskRoleSessionSet,
  fence: TaskRoleRunFence,
  pushedAt: Date
): TaskRoleSessionSet {
  validateRoleSessionSet(set);
  assertTaskRoleSessionSet(set);
  const inFlight = requireMatchingInFlight(set, fence);
  if (inFlight.pushedAt !== undefined) return set;
  const timestamp = requireDate(pushedAt, "Task Role Run pushedAt");
  if (Date.parse(timestamp) < Date.parse(inFlight.preparedAt)) {
    throw new Error("Task Role Run pushedAt must not be earlier than preparedAt.");
  }
  const updated: TaskRoleSessionSet = {
    ...set,
    inFlight: { ...inFlight, pushedAt: timestamp },
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
    inFlight: {
      ...inFlight,
      ...(inFlight.pushedAt === undefined ? { pushedAt: timestamp } : {}),
      deliveredAt: timestamp
    },
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
  if (inFlight.pushedAt === undefined) {
    throw new Error("Observed Turn Run must be pushed before completion is recorded.");
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

/**
 * Applies an authoritative application-level Run terminal fact to the native
 * session fence. A later native Hook is only advisory and must not be required
 * to make the next Run dispatchable.
 */
export function terminalizeTaskRoleRunSession(
  set: TaskRoleSessionSet,
  fence: TaskRoleRunFence,
  terminalAt: Date
): TaskRoleSessionSet {
  validateRoleSessionSet(set);
  const inFlight = set.inFlight;
  const pending = set.pendingTurnCompletion;
  let updated = pending !== null
    && pending.agentId === fence.agentId
    && pending.runId === fence.runId
    ? settleTaskRoleCompletion(set, {
        agentId: fence.agentId,
        runId: fence.runId,
        turnId: pending.turnId
      }, terminalAt)
    : inFlight === null
      ? set
      : clearTaskRoleRun(set, fence, terminalAt);
  const session = updated.sessions[updated.activeAgentId];
  if (session?.status === "running") {
    updated = updateRoleAgentSessionStatus(
      updated,
      updated.activeAgentId,
      "ready",
      terminalAt
    );
  }
  return updated;
}

/**
 * Resets the current native generation after its active Run is terminal.
 * The Controller separately owns verified process cleanup.
 */
export function resetTaskRoleSession(
  set: TaskRoleSessionSet,
  now: Date
): TaskRoleSessionSet {
  validateRoleSessionSet(set);
  const timestamp = requireDate(now, "Task Role Session reset timestamp");
  const current = set.sessions[set.activeAgentId];
  const sessions = { ...set.sessions };
  delete sessions[set.activeAgentId];
  const history = current === undefined
    ? set.history
    : [
        ...(set.history ?? []),
        { ...current, status: "broken" as const, updatedAt: timestamp }
      ];
  return validateRoleSessionSet({
    ...set,
    sessions,
    ...(history === undefined ? {} : { history }),
    inFlight: null,
    pendingTurnCompletion: null,
    updatedAt: timestamp
  });
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
  normalizeOwner(set.owner);
  requireSafeIdentity(set.activeAgentId, "Active Agent id");
  for (const [agentId, session] of Object.entries(set.sessions)) {
    validateRoleAgentSession(session, agentId);
  }
  if (set.owner.scope === "global") {
    if (set.schemaVersion !== 3) {
      throw new Error("Global Role session set schema version is invalid.");
    }
    if (
      Object.hasOwn(set, "inFlight")
      || Object.hasOwn(set, "pendingTurnCompletion")
    ) {
      throw new Error(
        "Global Role session set must not contain Task Role lifecycle fields."
      );
    }
    const history = (set as GlobalRoleSessionSet).history;
    if (history !== undefined) {
      for (const [ref, session] of Object.entries(history)) {
        requireSafeIdentity(ref, "Operator session ref");
        validateRoleAgentSession(session);
        if (session.status !== "stopped" && session.status !== "broken") {
          throw new Error(`Operator history session must be stopped: ${ref}.`);
        }
      }
    }
  } else {
    if (set.schemaVersion !== 4) {
      throw new Error("Task Role session set schema version is invalid.");
    }
    if (
      !Object.hasOwn(set, "inFlight")
      || !Object.hasOwn(set, "pendingTurnCompletion")
    ) {
      throw new Error("Task Role session set must contain its Turn fence.");
    }
    const taskSet = set as TaskRoleSessionSet;
    if (taskSet.history !== undefined) {
      if (!Array.isArray(taskSet.history)) {
        throw new Error("Task Role session history must be an array.");
      }
      const identities = new Set<string>();
      for (const session of taskSet.history) {
        validateRoleAgentSession(session);
        if (session.status !== "stopped" && session.status !== "broken") {
          throw new Error("Task Role session history must be terminal.");
        }
        const key = `${session.agentId}\0${session.nativeSessionId}`;
        if (identities.has(key)) {
          throw new Error("Task Role session history contains a duplicate native Session.");
        }
        identities.add(key);
      }
      for (const session of Object.values(taskSet.sessions)) {
        if (identities.has(`${session.agentId}\0${session.nativeSessionId}`)) {
          throw new Error("Active and historical Task Role Sessions must be distinct.");
        }
      }
    }
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
        || inFlight.pushedAt === undefined
      ) {
        throw new Error("Pending Turn completion must match a pushed in-flight Run.");
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
  if (session.schemaVersion !== 3) {
    throw new Error(`Role Agent session schema version is invalid: ${expectedAgentId}.`);
  }
  const agentId = requireSafeIdentity(session.agentId, "Agent id");
  if (agentId !== expectedAgentId) {
    throw new Error(`Role Agent session identity is inconsistent: ${expectedAgentId}.`);
  }
  requireText(session.adapterId, "Agent adapter id");
  validateEffectiveLaunchSnapshot(session.effective);
  if (session.effective.agentId !== agentId || session.effective.adapterId !== session.adapterId) {
    throw new Error(`Role Agent session effective identity is inconsistent: ${agentId}.`);
  }
  requireText(session.nativeSessionId, "Native session id");
  if (session.launchId !== undefined) requireSafeIdentity(session.launchId, "Launch id");
  if (
    session.title !== undefined
    && optionalSessionText("title", session.title).title !== session.title
  ) {
    throw new Error("Role Agent session title is invalid.");
  }
  if (
    session.preview !== undefined
    && optionalSessionText("preview", session.preview).preview !== session.preview
  ) {
    throw new Error("Role Agent session preview is invalid.");
  }
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

function optionalSessionText(
  field: "title" | "preview",
  value: string | undefined
): Partial<Pick<RoleAgentSession, "title" | "preview">> {
  if (value === undefined) return {};
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`Role Agent session ${field} is invalid.`);
  }
  const normalized = normalizeRoleAgentSessionText(value);
  if (normalized.length === 0 || normalized.length > 1_024) {
    throw new Error(`Role Agent session ${field} is invalid.`);
  }
  return { [field]: normalized };
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
    (field) => !["agentId", "runId", "receiptId", "preparedAt", "pushedAt", "deliveredAt"].includes(field)
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
  if (value.pushedAt !== undefined) {
    const pushedAt = requirePersistedTimestamp(value.pushedAt, "Task Role Run pushedAt");
    if (Date.parse(pushedAt) < Date.parse(preparedAt)) {
      throw new Error("Task Role Run pushedAt must not be earlier than preparedAt.");
    }
  }
  if (value.deliveredAt !== undefined) {
    const deliveredAt = requirePersistedTimestamp(
      value.deliveredAt,
      "Task Role Run deliveredAt"
    );
    if (Date.parse(deliveredAt) < Date.parse(preparedAt)) {
      throw new Error("Task Role Run deliveredAt must not be earlier than preparedAt.");
    }
    if (value.pushedAt === undefined) {
      throw new Error("Task Role Run deliveredAt requires a prior pushedAt.");
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
