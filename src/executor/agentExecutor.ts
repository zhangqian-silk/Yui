import { createHash } from "node:crypto";

import {
  hasRecentTurnId,
  rememberRecentTurnId,
  validateRecentTurnIds
} from "../runtime/recentTurnIds.js";
import {
  roleSessionMayContinue,
  validateEffectiveLaunchSnapshot,
  type EffectiveLaunchSnapshot
} from "./effectiveLaunch.js";
import {
  validateProviderRuntimeBinding,
  currentProviderConversation,
  type ProviderRuntimeBinding
} from "../runtime/providerRuntimeIdentity.js";
import { builtinDriverIdForAdapter, builtinAgentDriverRegistry } from "../runtime/builtinAgentDrivers.js";
import type { ImplementationRef } from "../kernel/instanceHost.js";
import {
  builtinAgentEndpointImplementation,
  validateAgentEndpointImplementation
} from "../runtime/agentEndpointIdentity.js";

/** Logical Session selection. A reserved ID alone does not prove a native
 * conversation exists; readiness, recoverability and activity are observations. */
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
  schemaVersion: 6;
  agentId: string;
  adapterId: string;
  nativeSessionId: string;
  title?: string;
  preview?: string;
  policy: "fixed" | "leader-controlled";
  /** Immutable actual configuration for this native session. */
  effective: EffectiveLaunchSnapshot;
  /** Fixed execution implementation; Host activations never silently upgrade it. */
  endpointImplementation: ImplementationRef;
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
  /**
   * Provider-native conversation and Turn observations for a Global Role's own
   * Session, matching the Task Role shape. Null means no controlled binding;
   * current records do not use an absent field as a second representation.
   * A Global control reads this binding to target the exact
   * current native Turn; it never fabricates a Task Role binding to do so.
   */
  providerBinding: ProviderRuntimeBinding | null;
  /** Native control evidence, not input intent or an execution queue. */
  interrupts?: Record<string, {
    fingerprint: string; attemptId: string; nativeSessionId: string; receiptId: string;
    receipt?: import("../runtime/agentHost.js").InterruptLiveReceipt;
  }>;
};

export type TaskRoleSessionSet = RoleSessionSetBase<TaskRoleSessionOwner> & {
  schemaVersion: 12;
  /** Immutable terminal native Sessions superseded by a fresh effective launch. */
  history?: readonly RoleAgentSession[];
  /** Provider-native conversation and Turn observations only. */
  providerBinding: ProviderRuntimeBinding | null;
};
export type RoleSessionSet = GlobalRoleSessionSet | TaskRoleSessionSet;

/** Recovery addresses retained execution identity, not a live Session grant.
 * A released Session cache can be absent while its native binding still needs
 * to be stopped. No active Session record is fabricated by this projection. */
export function taskRoleControlTarget(set: TaskRoleSessionSet | null | undefined) {
  if (set == null) return undefined;
  const current = set.sessions[set.activeAgentId];
  const binding = set.providerBinding;
  const fromBinding = binding !== null && (current === undefined
    || (binding.run !== null && ["submitting", "accepted", "delivery-unknown"].includes(binding.run.status))
    || (binding.goal !== null && binding.goal.status !== "complete"));
  const nativeSessionId = fromBinding ? currentProviderConversation(binding!).conversationId : current?.nativeSessionId;
  const agentId = fromBinding ? binding!.accountScope : current?.agentId;
  if (nativeSessionId === undefined || agentId === undefined) return undefined;
  const session = [...Object.values(set.sessions), ...(set.history ?? [])]
    .find(entry => entry.nativeSessionId === nativeSessionId && entry.agentId === agentId);
  const adapterId = session?.adapterId ?? (binding === null ? undefined : builtinAgentDriverRegistry().find(binding.providerNamespace)?.adapterId);
  return { nativeSessionId, agentId, adapterId, status: session?.status,
    updatedAt: session?.updatedAt ?? set.updatedAt, fromBinding };
}

export type ExecutorCapabilities = {
  recover: boolean;
  interrupt: boolean;
  nativeSessionDiscovery: boolean;
};

export type RecordRoleAgentSessionInput = {
  agentId: string;
  adapterId: string;
  nativeSessionId: string;
  title?: string;
  preview?: string;
  policy: RoleAgentSession["policy"];
  status: AgentSessionStatus;
  endReason?: AgentSessionEndReason;
  effective: EffectiveLaunchSnapshot;
  endpointImplementation?: ImplementationRef;
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
    ? { ...base, schemaVersion: 5, providerBinding: null } as GlobalRoleSessionSet
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
    && !roleSessionMayContinue(existing.effective, effective)) {
    throw new Error(
      `Role Agent session cannot continue under this launch: ${agentId}. `
      + "Its Agent, execution component, connection plan or physical workspace changed."
    );
  }
  if (existing !== undefined && existing.nativeSessionId !== nativeSessionId
    && existing.status === "active") {
    throw new Error(`Live Role Agent native session cannot be replaced: ${agentId}.`);
  }
  const timestamp = now.toISOString();
  const continuing = existing?.nativeSessionId === nativeSessionId ? existing : undefined;
  if (continuing !== undefined && input.endpointImplementation !== undefined
    && (continuing.endpointImplementation.id !== input.endpointImplementation.id
      || continuing.endpointImplementation.generation !== input.endpointImplementation.generation)) {
    throw new Error("A native Session cannot change its Endpoint implementation in place.");
  }
  const session: RoleAgentSession = {
    schemaVersion: 6,
    agentId,
    adapterId,
    nativeSessionId,
    ...optionalSessionText("title", input.title ?? continuing?.title),
    ...optionalSessionText("preview", input.preview ?? continuing?.preview),
    policy: input.policy,
    effective: continuing?.effective ?? effective,
    endpointImplementation: {
      ...(continuing?.endpointImplementation
        ?? input.endpointImplementation
        ?? builtinAgentEndpointImplementation(adapterId))
    },
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

/** Explicit fresh-session selection after physical stop. Keep every original
 * Run/result and the old native identity as history; never invent a new ID. */
export function selectNewTaskRoleSession(
  set: TaskRoleSessionSet,
  agentId: string,
  now: Date
): TaskRoleSessionSet {
  validateRoleSessionSet(set);
  const session = set.sessions[requireSafeIdentity(agentId, "Agent id")];
  if (session !== undefined && session.status !== "ended") {
    throw new Error("Stop the current Session before selecting a new one.");
  }
  if (set.activeAgentId === agentId && set.providerBinding !== null) {
    if (set.providerBinding.run !== null
      && ["submitting", "accepted", "delivery-unknown"].includes(set.providerBinding.run.status)
      || set.providerBinding.goal !== null && set.providerBinding.goal.status !== "complete") {
      throw new Error("Settle the exact native input and Goal before selecting a new Session.");
    }
  }
  if (session === undefined) return validateRoleSessionSet({
    ...set, ...(set.activeAgentId === agentId ? { providerBinding: null } : {}),
    updatedAt: now.toISOString()
  });
  const sessions = { ...set.sessions };
  delete sessions[agentId];
  return validateRoleSessionSet({
    ...set,
    sessions,
    history: [...(set.history ?? []), session],
    ...(set.activeAgentId === agentId ? { providerBinding: null } : {}),
    updatedAt: now.toISOString()
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
  // A Host status cannot supply a missing native Conversation identity.
  // Replacement remains an explicit operation even after that Host ended.
  if (
    typeof session.nativeSessionId !== "string"
    || session.nativeSessionId.trim().length === 0
  ) {
    throw new Error(
      `Role Agent session has no native Session identity: ${agentId}. `
      + "Restore the exact native Session or explicitly select a new Session."
    );
  }
  // An ended Host attachment is not evidence that the native Conversation
  // vanished. Resume the exact identity; only an explicit new-Session action
  // may replace it. A known unrecoverable Conversation needs that decision.
  const conversation = set.owner.scope === "task"
    ? (set as TaskRoleSessionSet).providerBinding?.conversations.find(
        (entry) => entry.conversationId === session.nativeSessionId
      )
    : undefined;
  if (conversation?.recoverability === "unrecoverable") {
    throw new Error(
      `Role Agent native Session is not recoverable: ${agentId}/${session.nativeSessionId}. `
      + (set.owner.scope === "task"
        ? `After stopping the exact idle Session, use yui task role session new ${set.owner.taskId} ${set.owner.roleName} --reason <evidence>, then retry the failed AgentRun. `
        : "Explicitly select a new Session to continue. ")
      + "Existing input attempts are not replayed."
    );
  }
  if (roleSessionMayContinue(session.effective, desired)) return "resume";
  throw new Error(
    `Role Agent session cannot continue under the next launch: ${agentId}. `
    + "Its Agent, adapter or physical workspace changed. Explicitly select a new Session "
    + "after resolving existing execution and resource ownership."
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
 * Bind a Global Role's Provider Runtime evidence, mirroring the Task Role
 * writer (decision-3 §6/§9). Create-only: an existing distinct binding is a
 * conflict, an identical one is idempotent. The Global set stays schemaVersion
 * 5; only the optional providerBinding is added.
 */
export function bindGlobalRoleProviderRuntime(
  set: GlobalRoleSessionSet,
  binding: ProviderRuntimeBinding,
  updatedAt: Date
): GlobalRoleSessionSet {
  validateRoleSessionSet(set);
  const normalized = validateProviderRuntimeBinding(binding);
  if (set.providerBinding != null) {
    if (JSON.stringify(set.providerBinding) === JSON.stringify(normalized)) return set;
    throw new Error("Global Role already has a Provider Runtime Binding.");
  }
  return validateRoleSessionSet({
    ...set,
    providerBinding: normalized,
    updatedAt: requireDate(updatedAt, "Provider Runtime Binding timestamp")
  });
}

/** In-place update of a Global Role's Provider Runtime binding; namespace and
 * account scope are immutable, exactly as for a Task Role. */
export function updateGlobalRoleProviderRuntime(
  set: GlobalRoleSessionSet,
  binding: ProviderRuntimeBinding,
  updatedAt: Date
): GlobalRoleSessionSet {
  validateRoleSessionSet(set);
  const normalized = validateProviderRuntimeBinding(binding);
  if (set.providerBinding == null
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
 * Session. Host connections are disposable execution
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
  const { endReason: _endReason, ...session } = active;
  const updated = validateRoleSessionSet({
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
  // Losing the attachment proves neither cancellation nor non-submission.
  // Preserve the exact input and its acceptance/unknown facts. Only a native
  // terminal or an explicit submission resolution may settle that attempt.
  return updated;
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
export function recordTaskRoleNativeTurnBoundary(
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
    ? ["schemaVersion", "owner", "activeAgentId", "sessions", "updatedAt", "history", "providerBinding", "interrupts"]
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
    const globalSet = set as GlobalRoleSessionSet;
    for (const [requestId, control] of Object.entries(globalSet.interrupts ?? {})) {
      requireSafeIdentity(requestId, "Global interrupt request");
      requireText(control.fingerprint, "Global interrupt fingerprint");
      requireText(control.attemptId, "Global interrupt attempt");
      requireText(control.nativeSessionId, "Global interrupt Session");
      requireText(control.receiptId, "Global interrupt receipt");
      if (control.receipt !== undefined
        && !["interrupt-requested", "interrupt-not-active", "interrupt-unknown", "interrupt-unavailable"]
          .includes(control.receipt.state)) throw new Error("Global interrupt receipt is invalid.");
    }
    const history = globalSet.history;
    if (history !== undefined) {
      for (const [ref, session] of Object.entries(history)) {
        requireSafeIdentity(ref, "Operator session ref");
        validateRoleAgentSession(session);
        if (session.status !== "ended") {
          throw new Error(`Operator history session must be stopped: ${ref}.`);
        }
      }
    }
    if (!Object.hasOwn(globalSet, "providerBinding")) {
      throw new Error("Global Role session set must contain its Provider Runtime Binding.");
    }
    if (globalSet.providerBinding !== null) {
      const providerBinding = validateProviderRuntimeBinding(globalSet.providerBinding);
      const conversationId = currentProviderConversation(providerBinding).conversationId;
      const session = [...Object.values(globalSet.sessions), ...Object.values(globalSet.history ?? {})]
        .find(entry => entry.agentId === providerBinding.accountScope && entry.nativeSessionId === conversationId);
      if (session !== undefined && providerBinding.providerNamespace !== builtinDriverIdForAdapter(session.adapterId)) {
        throw new Error("Provider Runtime Binding namespace does not match the Agent adapter.");
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
      const conversationId = currentProviderConversation(providerBinding).conversationId;
      const session = [...Object.values(taskSet.sessions), ...(taskSet.history ?? [])]
        .find(entry => entry.agentId === providerBinding.accountScope && entry.nativeSessionId === conversationId);
      // Execution control evidence may outlive the disposable Session cache.
      // It is not a live Session grant; recovery still needs native/OS proof.
      if (session !== undefined && providerBinding.providerNamespace !== builtinDriverIdForAdapter(session.adapterId)) {
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
  if (session.schemaVersion !== 6) {
    throw new Error(`Role Agent session schema version is invalid: ${expectedAgentId}.`);
  }
  const agentId = requireSafeIdentity(session.agentId, "Agent id");
  if (agentId !== expectedAgentId) {
    throw new Error(`Role Agent session identity is inconsistent: ${expectedAgentId}.`);
  }
  requireText(session.adapterId, "Agent adapter id");
  validateAgentEndpointImplementation(session.endpointImplementation);
  validateEffectiveLaunchSnapshot(session.effective);
  if (session.effective.agentId !== agentId || session.effective.adapterId !== session.adapterId) {
    throw new Error(`Role Agent session effective identity is inconsistent: ${agentId}.`);
  }
  requireText(session.nativeSessionId, "Native session id");
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
  throw new Error("Task Role session requires a native session identity.");
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
