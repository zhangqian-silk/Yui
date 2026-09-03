import { openCurrentTaskStore } from "../storage/currentTaskStore.js";
import {
  hasRuntimeCleanupObligation,
  isRuntimeLaunchReservation,
  runtimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";
import { nativeSessionIdForLaunch } from "../runtime/preallocatedNativeSession.js";
import {
  runtimeObservationFromTaskEvent,
  type RuntimeObservation
} from "../runtime/runtimeObservation.js";
import { formatTurnReceiptId } from "../task/taskRecordReference.js";
import { managedProviderTurnId } from "../runtime/providerRuntimeIdentity.js";
import type { TaskEvent } from "../event/taskEvent.js";

export type RuntimeHookTurnFence = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  launchId: string;
  turnId?: string;
  receiptId?: string;
  nativeSessionId: string;
  workspace: string;
}>;

export type RuntimeHookTurnFenceOptions = Readonly<{
  startupSession?: "preallocated" | "discovered";
  /** Terminal Hooks may arrive after the exact Turn has already completed. */
  terminal?: boolean;
  /** Stable Provider Turn identity used to recover its durable accepted Turn. */
  nativeTurnId?: string;
  /** Stable input identity used before the Provider has recorded a Turn id. */
  attemptId?: string;
  /** Session lifecycle observations remain valid while no Turn is active. */
  sessionOnly?: boolean;
  continuationId?: string;
  continuationGeneration?: number;
}>;

/**
 * Resolves turn identity from the current durable in-flight fence. The one
 * exception is a Driver-declared startup Session Hook, which can arrive before
 * Session projection and is fenced by the exact Turn-bound launch reservation.
 * Preallocated identities are additionally checked against Yui's deterministic
 * launch identity. The immutable event is revalidated by the inbox fold.
 */
export function resolveRuntimeHookTurnFence(
  environment: NodeJS.ProcessEnv,
  adapterId: string,
  payloadNativeSessionId: string,
  options: RuntimeHookTurnFenceOptions = {}
): RuntimeHookTurnFence {
  if (environment.YUI_SESSION_SCOPE !== "task") {
    throw new Error("Runtime observation Hook requires a Task session scope.");
  }
  if (environment.YUI_ADAPTER_ID !== adapterId) {
    throw new Error(`Runtime observation Hook requires the ${adapterId} adapter.`);
  }
  const home = requireIdentity(environment.YUI_HOME, "YUI_HOME");
  const taskId = requireIdentity(environment.YUI_TASK_ID, "Task id");
  const roleName = requireIdentity(environment.YUI_ROLE, "Role name");
  const agentId = requireIdentity(environment.YUI_AGENT_ID, "Agent id");
  const workspace = requireIdentity(environment.YUI_WORKSPACE, "YUI workspace");
  const nativeSessionId = requireIdentity(payloadNativeSessionId, "Provider session id");

  const store = openCurrentTaskStore(home);
  const task = store.getTask(taskId);
  if (task === null
    || (
      !(task.status === "active" && task.executionGate.state === "enabled")
      && !(task.status === "completed" && (options.terminal === true || options.sessionOnly === true))
    )) {
    throw new Error("Runtime observation Hook Task does not accept this lifecycle boundary.");
  }
  const role = store.getRole(taskId, roleName);
  if (role === null || role.activeAgentId !== agentId) {
    throw new Error("Runtime observation Hook Role or Agent is not current.");
  }
  const sessions = store.getTaskRoleSessionSet(taskId, roleName);
  if (sessions !== null && sessions.activeAgentId !== agentId) {
    throw new Error("Runtime observation Hook Session Agent is not current.");
  }
  const session = sessions?.sessions[agentId];
  const activeTurn = store.getActiveTurn(taskId, roleName);
  const providerTurn = sessions?.providerBinding?.turn;
  // Launch generation and Turn are durable facts, never envelope facts. A
  // native pane outlives both, so anything it inherited at launch is stale for
  // every later generation; the Session's own record (or the in-flight launch
  // reservation during startup) is the only current answer.
  const lifecycleMailbox = store.getWorkMailbox(runtimeLifecycleTarget({
    scope: "task",
    taskId,
    roleName
  }));
  const reservedLaunchId = isRuntimeLaunchReservation(lifecycleMailbox?.processing)
    ? lifecycleMailbox?.processing?.batchId
    : undefined;
  const launchId = requireIdentity(session?.launchId ?? reservedLaunchId, "Launch id");
  const durableTurnId = activeTurn?.id
    ?? managedProviderTurnId(providerTurn)
    ?? undefined;
  const directProviderTurn = providerTurn !== null
    && providerTurn !== undefined
    && providerTurn.turnId === undefined
    && (
      (options.attemptId !== undefined && providerTurn.attemptId === options.attemptId)
      || (options.nativeTurnId !== undefined && providerTurn.nativeTurnId === options.nativeTurnId)
    );
  const sessionOnlyObservation = options.sessionOnly === true && activeTurn === null;
  if (directProviderTurn || sessionOnlyObservation) {
    if (session === undefined
      || session.adapterId !== adapterId
      || session.launchId !== launchId
      || session.nativeSessionId !== nativeSessionId
      || session.effective.workspace.root !== workspace) {
      throw new Error("Runtime observation Hook Session does not match durable state.");
    }
    return {
      taskId,
      roleName,
      agentId,
      launchId,
      ...(directProviderTurn ? { receiptId: providerTurn.attemptId } : {}),
      nativeSessionId,
      workspace
    };
  }
  const activationReceiptId = providerTurn !== null
    && providerTurn !== undefined
    && managedProviderTurnId(providerTurn) === activeTurn?.id
    ? providerTurn.attemptId
    : activeTurn === null ? undefined : formatTurnReceiptId(taskId, activeTurn.id);
  const acceptedTurn = options.nativeTurnId === undefined
    ? null
    : acceptedTurnBinding(store.listEvents(taskId), {
        taskId,
        roleName,
        agentId,
        nativeSessionId,
        nativeTurnId: options.nativeTurnId
      });
  const acceptedBinding = acceptedTurn ?? (
    options.continuationId === undefined ? null : knownContinuationBinding(
      store.listEvents(taskId),
      {
        taskId,
        roleName,
        agentId,
        nativeSessionId,
        continuationId: options.continuationId,
        continuationGeneration: options.continuationGeneration ?? 1
      }
    )
  );
  const mailbox = lifecycleMailbox;
  const exactReservation = isRuntimeLaunchReservation(mailbox?.processing, launchId)
    && !hasRuntimeCleanupObligation(mailbox);
  const startupTurnId = options.startupSession === undefined
    ? undefined
    : requireIdentity(durableTurnId, "Turn id");
  const startupReservation = startupTurnId !== undefined
    && exactReservation
    && !hasRuntimeCleanupObligation(mailbox);
  const startupTurn = startupTurnId === undefined
    ? null
    : store.getTurn(taskId, startupTurnId);
  const replacementStartup = options.startupSession !== undefined
    && session !== undefined
    && sessions !== null
    && startupReservation
    && startupTurn?.mode === "new"
    && session.status === "ended";
  // The startup mode itself says whether Yui preallocated the native Session
  // id or the Provider reports it. A preallocated startup is proven against
  // Yui's deterministic launch identity, which is stronger than comparing a
  // value the launch envelope carried.
  const preallocatedStartup = options.startupSession === "preallocated"
    && (session === undefined || replacementStartup)
    && startupReservation
    && nativeSessionId === nativeSessionIdForLaunch(
      home,
      launchId,
      agentId,
      adapterId
    );
  const discoveredStartup = options.startupSession === "discovered"
    && (session === undefined || replacementStartup)
    && startupReservation;
  const terminalTurnId = options.terminal === true && acceptedBinding === null
    ? requireIdentity(durableTurnId, "Turn id")
    : undefined;
  const terminalTurn = acceptedBinding !== null
    ? store.getTurn(taskId, acceptedBinding.fence.turnId!)
    : terminalTurnId === undefined
    ? null
    : store.getTurn(taskId, terminalTurnId);
  const exactTerminal = terminalTurn !== null
    && terminalTurn.status !== "active"
    && terminalTurn.roleName === roleName
    && terminalTurn.effective.agentId === agentId
    && terminalTurn.effective.adapterId === adapterId
    && session !== undefined;
  if (activeTurn === null
    && !preallocatedStartup
    && !discoveredStartup
    && !exactTerminal
    && acceptedBinding === null) {
    throw new Error("Runtime observation Hook has no matching durable in-flight Turn.");
  }
  const turnId = acceptedBinding?.fence.turnId
    ?? activeTurn?.id
    ?? startupTurnId
    ?? terminalTurnId!;
  const effectiveLaunchId = acceptedBinding?.fence.launchId ?? launchId;
  const turn = acceptedBinding !== null || exactTerminal
    ? terminalTurn
    : store.getActiveTurn(taskId, roleName);
  if (turn === null
    || turn.id !== turnId
    || (acceptedBinding === null && !exactTerminal && turn.status !== "active")
    || turn.effective.agentId !== agentId
    || turn.effective.adapterId !== adapterId) {
    throw new Error("Runtime observation Hook Turn does not match durable active state.");
  }
  if (turn.effective.workspace.root !== workspace) {
    throw new Error("Runtime observation Hook workspace does not match the durable Turn snapshot.");
  }
  if (session !== undefined && acceptedBinding === null && !replacementStartup) {
    if (session.adapterId !== adapterId
      || session.launchId !== effectiveLaunchId
      || session.nativeSessionId !== nativeSessionId
      || session.effective.workspace.root !== workspace) {
      throw new Error("Runtime observation Hook Session does not match its durable generation.");
    }
  } else if (acceptedBinding === null && (session === undefined || replacementStartup)) {
    if (!discoveredStartup && !preallocatedStartup) {
      throw new Error("Runtime observation Hook launch is not durably reserved.");
    }
  }
  return {
    taskId,
    roleName,
    agentId,
    launchId: effectiveLaunchId,
    turnId,
    ...(acceptedBinding?.fence.receiptId === undefined
      ? activationReceiptId === undefined ? {} : { receiptId: activationReceiptId }
      : { receiptId: acceptedBinding.fence.receiptId }),
    nativeSessionId,
    workspace
  };
}

function knownContinuationBinding(
  events: readonly TaskEvent[],
  expected: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    nativeSessionId: string;
    continuationId: string;
    continuationGeneration: number;
  }>
): RuntimeObservation | null {
  const matches = events
    .map(runtimeObservationFromTaskEvent)
    .filter((observation): observation is RuntimeObservation => observation !== null
      && observation.kind.startsWith("continuation.")
      && observation.fence.taskId === expected.taskId
      && observation.fence.roleName === expected.roleName
      && observation.fence.agentId === expected.agentId
      && observation.fence.nativeSessionId === expected.nativeSessionId
      && observation.fence.continuationId === expected.continuationId
      && observation.fence.continuationGeneration === expected.continuationGeneration
      && observation.fence.turnId !== undefined)
    .sort((left, right) => (
      left.receivedAt.localeCompare(right.receivedAt)
      || (left.sequence ?? -1) - (right.sequence ?? -1)
      || (left.ordinal ?? -1) - (right.ordinal ?? -1)
      || left.eventId.localeCompare(right.eventId)
    ));
  const binding = matches.at(-1) ?? null;
  if (binding === null) return null;
  if (matches.some((candidate) => candidate.fence.turnId !== binding.fence.turnId
    || candidate.fence.launchId !== binding.fence.launchId
    || candidate.fence.receiptId !== binding.fence.receiptId)) {
    throw new Error("Runtime observation Hook continuation has conflicting durable Turn bindings.");
  }
  return binding;
}

function acceptedTurnBinding(
  events: readonly TaskEvent[],
  expected: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    nativeSessionId: string;
    nativeTurnId: string;
  }>
): RuntimeObservation | null {
  const matches = events
    .map(runtimeObservationFromTaskEvent)
    .filter((observation): observation is RuntimeObservation => observation !== null
      && observation.kind === "turn.accepted"
      && observation.fence.taskId === expected.taskId
      && observation.fence.roleName === expected.roleName
      && observation.fence.agentId === expected.agentId
      && observation.fence.nativeSessionId === expected.nativeSessionId
      && observation.fence.nativeTurnId === expected.nativeTurnId
      && observation.fence.turnId !== undefined)
    .sort((left, right) => (
      left.receivedAt.localeCompare(right.receivedAt)
      || (left.sequence ?? -1) - (right.sequence ?? -1)
      || (left.ordinal ?? -1) - (right.ordinal ?? -1)
      || left.eventId.localeCompare(right.eventId)
    ));
  const binding = matches.at(-1) ?? null;
  if (binding === null) return null;
  if (matches.some((candidate) => candidate.fence.turnId !== binding.fence.turnId
    || candidate.fence.launchId !== binding.fence.launchId
    || candidate.fence.receiptId !== binding.fence.receiptId)) {
    throw new Error("Runtime observation Hook native Turn has conflicting durable Turn bindings.");
  }
  return binding;
}

function requireIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`${label} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 1_024) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}
