import { createHash } from "node:crypto";

import {
  hasRecentTurnId,
  rememberRecentTurnId,
  validateRecentTurnIds
} from "../runtime/recentTurnIds.js";
import {
  effectiveLaunchSnapshotsCompatible,
  effectiveLaunchSnapshotsCompatibleForTaskSession,
  validateEffectiveLaunchSnapshot,
  type EffectiveLaunchSnapshot
} from "./effectiveLaunch.js";
import {
  currentProviderActivation,
  endProviderActivation,
  settleProviderTurn,
  settleProviderTurnSubmission,
  validateProviderRuntimeBinding,
  type ProviderRuntimeBinding
} from "../runtime/providerRuntimeIdentity.js";
import { builtinDriverIdForAdapter } from "../runtime/builtinAgentDrivers.js";

/** Session existence only. Readiness and activity belong to Host/Turn facts. */
export type AgentSessionStatus = "active" | "ended";
export type AgentSessionEndReason = "stopped" | "failed";

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
  schemaVersion: 5;
  agentId: string;
  adapterId: string;
  nativeSessionId: string;
  /** Durable exact generation identity for native lifecycle events. */
  runtimeGenerationId?: string;
  title?: string;
  preview?: string;
  policy: "fixed" | "leader-controlled";
  /** Immutable actual configuration for this native session. */
  effective: EffectiveLaunchSnapshot;
  status: AgentSessionStatus;
  endReason?: AgentSessionEndReason;
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

export type GlobalRoleSessionSet = RoleSessionSetBase<GlobalRoleSessionOwner> & {
  schemaVersion: 5;
  /** Immutable terminal native Sessions keyed by an opaque Yui reference. */
  history?: Record<string, RoleAgentSession>;
};

export type TaskRoleSessionSet = RoleSessionSetBase<TaskRoleSessionOwner> & {
  schemaVersion: 12;
  /** Immutable terminal native Sessions superseded by a fresh effective launch. */
  history?: readonly RoleAgentSession[];
  /** Provider-native conversation and Turn observations only. */
  providerBinding: ProviderRuntimeBinding | null;
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
  runtimeGenerationId?: string;
  title?: string;
  preview?: string;
  policy: RoleAgentSession["policy"];
  status: AgentSessionStatus;
  endReason?: AgentSessionEndReason;
  effective: EffectiveLaunchSnapshot;
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
  const base = {
    owner: normalizeOwner(owner),
    activeAgentId: requireSafeIdentity(activeAgentId, "Active Agent id"),
    sessions: {},
    updatedAt: now.toISOString()
  };
  return owner.scope === "global"
    ? { ...base, schemaVersion: 5 } as GlobalRoleSessionSet
    : {
        ...base,
        schemaVersion: 12,
        providerBinding: null
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
  return session === null || session.status === "ended"
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
      || (input.runtimeGenerationId !== undefined && entry.runtimeGenerationId === input.runtimeGenerationId)
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
    && !effectiveLaunchSnapshotsCompatible(existing.effective, effective)
    && !(set.owner.scope === "task"
      && effectiveLaunchSnapshotsCompatibleForTaskSession(existing.effective, effective))) {
    throw new Error(`Role Agent session effective launch cannot change: ${agentId}.`);
  }
  if (existing !== undefined && existing.nativeSessionId !== nativeSessionId
    && existing.status === "active") {
    throw new Error(`Live Role Agent native session cannot be replaced: ${agentId}.`);
  }
  const timestamp = now.toISOString();
  const continuing = existing?.nativeSessionId === nativeSessionId ? existing : undefined;
  const session: RoleAgentSession = {
    schemaVersion: 5,
    agentId,
    adapterId,
    nativeSessionId,
    ...(input.runtimeGenerationId === undefined
      ? continuing?.runtimeGenerationId === undefined ? {} : { runtimeGenerationId: continuing.runtimeGenerationId }
      : { runtimeGenerationId: requireText(input.runtimeGenerationId, "Runtime generation id") }),
    ...optionalSessionText("title", input.title ?? continuing?.title),
    ...optionalSessionText("preview", input.preview ?? continuing?.preview),
    policy: input.policy,
    effective: continuing?.effective ?? effective,
    status: input.status,
    ...(input.status === "ended"
      ? { endReason: input.endReason ?? continuing?.endReason ?? "stopped" }
      : {}),
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

/** Atomically archives a disposable old native Session and binds its replacement. */
export function replaceTaskRoleAgentSession(
  set: TaskRoleSessionSet,
  input: RecordRoleAgentSessionInput,
  now: Date
): TaskRoleSessionSet {
  validateRoleSessionSet(set);
  const existing = set.sessions[input.agentId];
  if (existing === undefined || existing.nativeSessionId === input.nativeSessionId) {
    return recordRoleAgentSession(set, input, now);
  }
  const terminalized = updateRoleAgentSessionStatus(
    set,
    input.agentId,
    "ended",
    now,
    "stopped"
  );
  return recordRoleAgentSession(terminalized, input, now);
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
  now: Date,
  endReason?: AgentSessionEndReason
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
      [normalizedAgentId]: {
        ...existing,
        status,
        ...(status === "ended" ? { endReason: endReason ?? "stopped" } : { endReason: undefined }),
        updatedAt: timestamp
      }
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
  const live = Object.values(set.sessions).find(
    ({ status }) => status === "active"
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
    providerBinding: null,
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
  const timestamp = now.toISOString();
  let changed = false;
  const sessions = Object.fromEntries(Object.entries(set.sessions).map(([agentId, session]) => {
    const isNeverStartedInactiveClaude = agentId !== set.activeAgentId
      && session.adapterId === "claude"
      && session.status === "active"
      && session.runtimeGenerationId === undefined
      && session.recentCompletedTurnIds.length === 0;
    if (!isNeverStartedInactiveClaude) return [agentId, session];
    changed = true;
    return [agentId, {
      ...session,
      status: "ended" as const,
      endReason: "failed" as const,
      updatedAt: timestamp
    }];
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
  const normalizedTurnId = requireText(turnId, "Turn id");
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
  if (session === undefined) return "new";
  // A restored opaque host can be inspected/recovered only through its exact
  // launch fence. It cannot be resumed or silently rebound to a new launch
  // without a provider-native identity; an explicit verified stop still
  // permits the normal fresh-generation path.
  if (
    typeof session.nativeSessionId !== "string"
    || session.nativeSessionId.trim().length === 0
  ) {
    if (session.status === "active") {
      throw new Error(
        `Role Agent session has no native Session identity: ${agentId}. `
        + "Restore the exact native Session or explicitly stop it before starting a fresh Session."
      );
    }
    return "new";
  }
  if (session.status === "ended") {
    return "new";
  }
  const compatible = set.owner.scope === "task"
    ? effectiveLaunchSnapshotsCompatibleForTaskSession(session.effective, desired)
    : effectiveLaunchSnapshotsCompatible(session.effective, desired);
  if (compatible) return "resume";
  throw new Error(
    `Role Agent session is incompatible with the next effective launch: ${agentId}. `
    + "Stop the existing native process before starting a fresh Session."
  );
}

export function bindTaskRoleProviderRuntime(
  set: TaskRoleSessionSet,
  binding: ProviderRuntimeBinding,
  updatedAt: Date
): TaskRoleSessionSet {
  validateRoleSessionSet(set);
  const normalized = validateProviderRuntimeBinding(binding);
  if (set.providerBinding !== null) {
    if (JSON.stringify(set.providerBinding) === JSON.stringify(normalized)) return set;
    throw new Error("Task Role already has a Provider Runtime Binding.");
  }
  return validateRoleSessionSet({
    ...set,
    providerBinding: normalized,
    updatedAt: requireDate(updatedAt, "Provider Runtime Binding timestamp")
  });
}

export function updateTaskRoleProviderRuntime(
  set: TaskRoleSessionSet,
  binding: ProviderRuntimeBinding,
  updatedAt: Date
): TaskRoleSessionSet {
  validateRoleSessionSet(set);
  const normalized = validateProviderRuntimeBinding(binding);
  if (set.providerBinding === null
    || normalized.providerNamespace !== set.providerBinding.providerNamespace
    || normalized.accountScope !== set.providerBinding.accountScope) {
    throw new Error("Provider Runtime Binding identity cannot change in place.");
  }
  return validateRoleSessionSet({
    ...set,
    providerBinding: normalized,
    updatedAt: requireDate(updatedAt, "Provider Runtime Binding timestamp")
  });
}

/**
 * Detaches a confirmed-dead local Host without ending its resumable native
 * Session. The Host launch and Provider Activation are disposable execution
 * facts; the native Session remains the durable continuation identity.
 */
export function detachRoleAgentSessionHost<TSet extends RoleSessionSet>(
  set: TSet,
  now: Date
): TSet {
  validateRoleSessionSet(set);
  const active = set.sessions[set.activeAgentId];
  if (active === undefined || active.status === "ended") return set;
  const timestamp = requireDate(now, "Role Host detach timestamp");
  const { runtimeGenerationId: _runtimeGenerationId, endReason: _endReason, ...session } = active;
  let updated = validateRoleSessionSet({
    ...set,
    sessions: {
      ...set.sessions,
      [set.activeAgentId]: {
        ...session,
        status: "active",
        updatedAt: timestamp
      }
    },
    updatedAt: timestamp
  }) as TSet;
  if (updated.owner.scope !== "task") return updated;
  let taskSet = updated as TaskRoleSessionSet;
  let binding = taskSet.providerBinding;
  const turn = binding?.turn;
  if (binding !== null && binding !== undefined && turn !== null && turn !== undefined
    && turn.status === "accepted") {
    binding = settleProviderTurn(binding, {
      nativeTurnId: turn.nativeTurnId!,
      status: "cancelled",
      settledAt: timestamp,
      reason: "runtime-physical-exit"
    });
    taskSet = updateTaskRoleProviderRuntime(taskSet, binding, now);
  } else if (binding !== null && binding !== undefined && turn !== null && turn !== undefined
    && ["submitting", "delivery-unknown"].includes(turn.status)) {
    binding = settleProviderTurnSubmission(binding, {
      attemptId: turn.attemptId,
      status: "rejected",
      resolvedAt: timestamp,
      reason: "runtime-physical-exit"
    });
    taskSet = updateTaskRoleProviderRuntime(taskSet, binding, now);
  }
  const activation = binding === null
    ? null
    : currentProviderActivation(binding);
  if (activation !== null) {
    taskSet = updateTaskRoleProviderRuntime(
      taskSet,
      endProviderActivation(binding!, activation.activationId, {
        status: "ended",
        endedAt: now.toISOString(),
        reason: "runtime-physical-exit"
      }),
      now
    );
  }
  return taskSet as TSet;
}

/**
 * Records a Provider activity boundary without changing the durable Yui Turn.
 *
 * A native session may finish one foreground Turn while provider-owned
 * subagents, mailbox work, or later user corrections still belong to the same
 * application-level Turn. Only the native Provider terminal may clear the
 * Turn fence; this transition merely makes the native Session available for a
 * subsequent input and remembers the provider Turn idempotently.
 */
export function recordTaskRoleTurnBoundary(
  set: TaskRoleSessionSet,
  input: Readonly<{
    agentId: string;
    nativeSessionId: string;
    turnId: string;
  }>,
  completedAt: Date
): TaskRoleSessionSet {
  validateRoleSessionSet(set);
  assertTaskRoleSessionSet(set);
  const agentId = requireSafeIdentity(input.agentId, "Agent id");
  const nativeSessionId = requireText(input.nativeSessionId, "Native session id");
  const turnId = requireText(input.turnId, "Turn id");
  const session = set.sessions[agentId];
  if (session === undefined || session.nativeSessionId !== nativeSessionId) {
    throw new Error("Completed Turn has no matching Role Agent native session.");
  }
  if (session.recentCompletedTurnIds.includes(turnId)) return set;
  const timestamp = requireDate(completedAt, "Turn completedAt");
  return validateRoleSessionSet({
    ...set,
    sessions: {
      ...set.sessions,
      [agentId]: {
        ...session,
        recentCompletedTurnIds: rememberRecentTurnId(
          session.recentCompletedTurnIds,
          turnId
        ),
        updatedAt: timestamp
      }
    },
    updatedAt: timestamp
  });
}

export function validateRoleSessionSet<TSet extends RoleSessionSet>(set: TSet): TSet {
  const ownerScope = (set as unknown as { owner?: { scope?: unknown } }).owner?.scope;
  rejectUnknownFields(set as unknown as Record<string, unknown>, ownerScope === "global"
    ? ["schemaVersion", "owner", "activeAgentId", "sessions", "updatedAt", "history"]
    : [
        "schemaVersion",
        "owner",
        "activeAgentId",
        "sessions",
        "updatedAt",
        "history",
        "providerBinding"
      ], "Role session set");
  normalizeOwner(set.owner);
  requireSafeIdentity(set.activeAgentId, "Active Agent id");
  for (const [agentId, session] of Object.entries(set.sessions)) {
    validateRoleAgentSession(session, agentId);
  }
  if (set.owner.scope === "global") {
    if (set.schemaVersion !== 5) {
      throw new Error("Global Role session set schema version is invalid.");
    }
    if (
      Object.hasOwn(set, "providerBinding")
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
        if (session.status !== "ended") {
          throw new Error(`Operator history session must be stopped: ${ref}.`);
        }
      }
    }
  } else {
    if (set.schemaVersion !== 12) {
      throw new Error("Task Role session set schema version is invalid.");
    }
    if (!Object.hasOwn(set, "providerBinding")) {
      throw new Error("Task Role session set must contain its Provider Runtime Binding.");
    }
    const taskSet = set as TaskRoleSessionSet;
    if (taskSet.history !== undefined) {
      if (!Array.isArray(taskSet.history)) {
        throw new Error("Task Role session history must be an array.");
      }
      const identities = new Set<string>();
      for (const session of taskSet.history) {
        validateRoleAgentSession(session);
        if (session.status !== "ended") {
          throw new Error("Task Role session history must be terminal.");
        }
        const key = taskRoleSessionIdentity(session);
        if (identities.has(key)) {
          throw new Error("Task Role session history contains a duplicate Session identity.");
        }
        identities.add(key);
      }
      for (const session of Object.values(taskSet.sessions)) {
        if (identities.has(taskRoleSessionIdentity(session))) {
          throw new Error("Active and historical Task Role Sessions must be distinct.");
        }
      }
    }
    const providerBinding = taskSet.providerBinding === null
      ? null
      : validateProviderRuntimeBinding(taskSet.providerBinding);
    if (providerBinding !== null) {
      const session = taskSet.sessions[set.activeAgentId];
      if (session === undefined) {
        throw new Error("Provider Runtime Binding has no active Role Agent session.");
      }
      if (providerBinding.providerNamespace !== builtinDriverIdForAdapter(session.adapterId)) {
        throw new Error("Provider Runtime Binding namespace does not match the Agent adapter.");
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
  if (session.schemaVersion !== 5) {
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
  // A restored opaque host may have no provider-native identity; retain its
  // launch fence so it can be inspected or stopped without inventing identity.
  if (session.nativeSessionId === undefined) {
    if (session.runtimeGenerationId === undefined) {
      throw new Error("Role Agent session requires a native Session or runtime generation id.");
    }
  } else {
    requireText(session.nativeSessionId, "Native session id");
  }
  if (session.runtimeGenerationId !== undefined) requireSafeIdentity(session.runtimeGenerationId, "Runtime generation id");
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
  if (session.status === "active" && session.endReason !== undefined) {
    throw new Error(`Active Role Agent session cannot have an end reason: ${agentId}.`);
  }
  if (session.status === "ended"
    && session.endReason !== "stopped"
    && session.endReason !== "failed") {
    throw new Error(`Ended Role Agent session requires an end reason: ${agentId}.`);
  }
  validateRecentTurnIds(session.recentCompletedTurnIds);
  requireText(session.createdAt, "Role Agent session creation timestamp");
  requireText(session.updatedAt, "Role Agent session update timestamp");
  return session;
}

function taskRoleSessionIdentity(session: RoleAgentSession): string {
  if (session.nativeSessionId !== undefined) {
    return `${session.agentId}\0native\0${session.nativeSessionId}`;
  }
  if (session.runtimeGenerationId === undefined) {
    throw new Error("Opaque Task Role session requires a runtime generation identity.");
  }
  return `${session.agentId}\0runtime-generation\0${session.runtimeGenerationId}`;
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

function requireDate(value: Date, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label} must be a valid date.`);
  }
  return value.toISOString();
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
  return value === "active" || value === "ended";
}

function requireSafeIdentity(value: string, label: string): string {
  const normalized = requireText(value, label);
  if (["__proto__", "prototype", "constructor", ".", ".."].includes(normalized)
    || /[\/\\\0]/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string
): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown !== undefined) throw new Error(`${label} has unknown field: ${unknown}.`);
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}
