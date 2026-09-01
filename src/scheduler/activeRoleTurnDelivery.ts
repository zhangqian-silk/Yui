import { serializeTurnInputEnvelope } from "../context/turnInputContract.js";
import {
  effectiveLaunchSnapshotsCompatible,
  effectiveLaunchSnapshotsCompatibleForTaskSession
} from "../executor/effectiveLaunch.js";
import { RuntimeLifecycleBusyError } from "../runtime/lifecycleReservation.js";
import { managedProviderTurnId } from "../runtime/providerRuntimeIdentity.js";
import { serializeAgentErrorRaw } from "../runtime/agentError.js";
import { RuntimeLaunchFailure } from "../runtime/launchDiagnostics.js";
import { RuntimeLaunchError, type RuntimeLaunchPreflight } from "../runtime/ports.js";
import { formatTurnReceiptId } from "../task/taskRecordReference.js";
import { turnInputEnvelope } from "../turn/turn.js";
import type {
  PreparedRoleDelivery,
  SchedulerTurn,
  SchedulerRole,
  SchedulerRoleSession,
  SchedulerStorePort,
  SchedulerTask,
  TmuxDeliveryPort
} from "./ports.js";
import {
  isSchedulerTaskWorkspaceReady,
  selectedActiveSchedulerTasks,
  selectedSchedulerRoles,
  type SchedulerReconcileSelection
} from "./ports.js";

export type ActiveRoleTurnDeliveryResult = Readonly<{
  taskId: string;
  roleName: string;
  turnId: string;
  status: "delivered" | "already-delivered" | "skipped" | "failed";
  reason?: "workspace-not-ready" | "launch-failed" | "generation-lost" | "provider-rejected" | "mailbox-empty" | "mailbox-busy" | "not-ready" | "runtime-unavailable" | "writer-attached" | "delivery-uncertain";
  error?: string;
  terminalized?: boolean;
}>;

/**
 * Sole managed Provider write path. A Turn is durable workflow intent;
 * each invocation here is an ordinary Provider-native Turn on the Role's
 * shared conversation. Stable request ids make a repeated submit idempotent
 * without copying Provider delivery state into Turn or WorkMailbox.
 */
export async function processActiveRoleTurnDeliveries(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  now: Date,
  selection?: SchedulerReconcileSelection
): Promise<ActiveRoleTurnDeliveryResult[]> {
  const results: ActiveRoleTurnDeliveryResult[] = [];
  for (const task of selectedActiveSchedulerTasks(store, selection)) {
    for (const role of selectedSchedulerRoles(store, task.id, selection)) {
      const turn = store.getActiveTurn(task.id, role.name);
      if (turn === null) continue;
      results.push(await deliverActiveTurn(store, delivery, task, role, turn, now));
    }
  }
  return results;
}

async function deliverActiveTurn(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  task: SchedulerTask,
  role: SchedulerRole,
  turn: SchedulerTurn,
  now: Date
): Promise<ActiveRoleTurnDeliveryResult> {
  const base = { taskId: task.id, roleName: role.name, turnId: turn.id };
  if (!isSchedulerTaskWorkspaceReady(task, store.getTaskWorkspace(task.id))) {
    return { ...base, status: "skipped", reason: "workspace-not-ready" };
  }

  const sessionSet = store.getTaskRoleSessionSet?.(task.id, role.name) ?? null;
  const binding = sessionSet?.providerBinding ?? null;
  const observedTurn = binding?.turn ?? null;
  const initialAttemptId = formatTurnReceiptId(task.id, turn.id);
  const currentProviderTurn = managedProviderTurnId(observedTurn) === turn.id ? observedTurn : null;

  if (binding?.authority.owner === "human"
    || binding?.authority.owner === "unknown") {
    return { ...base, status: "skipped", reason: "writer-attached" };
  }
  if (currentProviderTurn !== null
    && ["submitting", "accepted"].includes(currentProviderTurn.status)) {
    return { ...base, status: "skipped", reason: "not-ready" };
  }
  if (currentProviderTurn?.status === "delivery-unknown") {
    return failTurnDelivery(store, turn, now, "delivery-unknown",
      currentProviderTurn.terminalReason ?? "Provider could not determine whether the Turn was accepted.");
  }

  if (currentProviderTurn !== null) {
    const reason = currentProviderTurn.terminalReason
      ?? `Provider Turn ended with status ${currentProviderTurn.status} without recording its Turn result.`;
    return failTurnDelivery(store, turn, now, "missing-result", reason);
  }

  const attemptId = initialAttemptId;
  const mode = turn.mode;
  const existingSession = store.getRoleSession(task.id, role.name, turn.effective.agentId);
  let prepared: PreparedRoleDelivery | undefined;
  let submitted = false;
  try {
    const nativeSessionId = mode === "resume"
      ? requireResumeSession(role, turn, existingSession)
      : undefined;
    prepared = await delivery.prepareRoleSession({
      taskId: task.id,
      roleName: role.name,
      agentId: turn.effective.agentId,
      adapterId: turn.effective.adapterId,
      effective: turn.effective,
      workspace: turn.effective.workspace.root,
      ...(turn.workspace === undefined ? {} : { managedWorkspace: turn.workspace }),
      mode,
      turnId: turn.id,
      ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
      ...(mode !== "resume" || existingSession?.launchId === undefined
        ? {}
        : { hostActivationId: existingSession.launchId }),
      beforeHostStart: (preflight) => persistPreStartSession(
        store,
        task,
        role,
        turn,
        existingSession,
        mode,
        preflight,
        now
      )
    });
    const preparedSession = prepared.session === undefined
      ? existingSession
      : validateRoleSession(role, turn, existingSession, mode, prepared.session);
    store.saveRoleTurnPrepared({
      task,
      role,
      turn,
      session: preparedSession,
      ...(prepared.launchId === undefined ? {} : { launchId: prepared.launchId }),
      now
    });

    const ready = await delivery.waitUntilReady(prepared);
    const readySession = validateRoleSession(role, turn, existingSession, mode, ready.session);
    store.saveRoleTurnPrepared({
      task,
      role,
      turn,
      session: readySession,
      ...(ready.prepared.launchId === undefined ? {} : { launchId: ready.prepared.launchId }),
      now
    });
    submitted = true;
    const outcome = await delivery.sendOnce({
      delivery: ready,
      receiptId: attemptId,
      text: serializeTurnInputEnvelope(turnInputEnvelope(turn))
    });

    if (outcome === "busy" || outcome === "unavailable") {
      forget(delivery, task.id, role.name, turn.id, ready.prepared.launchId);
      return {
        ...base,
        status: "skipped",
        reason: outcome === "busy" ? "not-ready" : "runtime-unavailable"
      };
    }
    if (outcome === "rejected" || outcome === "delivery-unknown") {
      forget(delivery, task.id, role.name, turn.id, ready.prepared.launchId);
      return failTurnDelivery(
        store,
        turn,
        now,
        outcome === "delivery-unknown" ? "delivery-unknown" : "runtime-failed",
        outcome === "delivery-unknown"
          ? "Provider Turn delivery is ambiguous; Yui will not replay it automatically."
          : "Provider rejected the managed Turn."
      );
    }
    forget(delivery, task.id, role.name, turn.id, ready.prepared.launchId);
    return {
      ...base,
      status: outcome === "sent" ? "delivered" : "already-delivered"
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.recordAgentError?.({
      taskId: task.id,
      roleName: role.name,
      turnId: turn.id,
      source: error instanceof RuntimeLaunchError || error instanceof RuntimeLaunchFailure ? "host" : "yui",
      phase: submitted ? "turn-submit" : mode === "new" ? "session-start" : "session-restore",
      message,
      raw: serializeAgentErrorRaw(error),
      inputDisposition: submitted ? "unknown" : "not-accepted"
    }, now);
    if (error instanceof RuntimeLifecycleBusyError
      || (error instanceof RuntimeLaunchError && error.retryable)) {
      return {
        ...base,
        status: "skipped",
        reason: error instanceof RuntimeLaunchError && error.reason === "writable-client"
          ? "writer-attached"
          : "runtime-unavailable",
        error: message
      };
    }
    forget(delivery, task.id, role.name, turn.id, prepared?.launchId);
    return failTurnDelivery(
      store,
      turn,
      now,
      submitted ? "delivery-unknown" : "startup-failed",
      message
    );
  }
}

function failTurnDelivery(
  store: SchedulerStorePort,
  turn: SchedulerTurn,
  now: Date,
  failureReason: import("../turn/turn.js").TurnFailureReason,
  summary: string
): ActiveRoleTurnDeliveryResult {
  const disposition = store.saveRoleTurnDeliveryFailure({
    taskId: turn.taskId,
    roleName: turn.roleName,
    agentId: turn.effective.agentId,
    adapterId: turn.effective.adapterId,
    turnId: turn.id,
    failureReason,
    summary,
    now
  });
  return {
    taskId: turn.taskId,
    roleName: turn.roleName,
    turnId: turn.id,
    status: disposition === "failed" ? "failed" : "skipped",
    reason: failureReason === "delivery-unknown" ? "delivery-uncertain" : "launch-failed",
    error: summary,
    ...(disposition === "failed" ? { terminalized: true } : {})
  };
}

function persistPreStartSession(
  store: SchedulerStorePort,
  task: SchedulerTask,
  role: SchedulerRole,
  turn: SchedulerTurn,
  existing: SchedulerRoleSession | null,
  mode: "new" | "resume",
  preflight: RuntimeLaunchPreflight,
  now: Date
): void {
  if (preflight.owner.scope !== "task"
    || preflight.owner.taskId !== task.id
    || preflight.owner.roleName !== role.name
    || preflight.turnId !== turn.id
    || preflight.launchId.trim().length === 0) {
    throw new Error(`Pre-start launch fence changed the active Role Turn: ${task.id}/${role.name}.`);
  }
  const session = preflight.nativeSessionId === undefined ? null : {
    agentId: preflight.agentId,
    adapterId: preflight.adapterId,
    nativeSessionId: preflight.nativeSessionId,
    launchId: preflight.launchId,
    ...(preflight.sessionTitle === undefined ? {} : { title: preflight.sessionTitle }),
    status: "active" as const,
    effective: preflight.effective
  };
  store.saveRoleTurnPrepared({
    task,
    role,
    turn,
    session: validateRoleSession(role, turn, existing, mode, session),
    launchId: preflight.launchId,
    now
  });
}

function validateRoleSession(
  role: SchedulerRole,
  turn: SchedulerTurn,
  existing: SchedulerRoleSession | null,
  mode: "new" | "resume",
  session: SchedulerRoleSession | null
): SchedulerRoleSession | null {
  if (mode === "new" && session === null) return null;
  if (session === null || !hasText(session.nativeSessionId)) {
    throw new Error(`Ready Role session has no native session id: ${role.taskId}/${role.name}.`);
  }
  if (session.agentId !== turn.effective.agentId
    || session.adapterId !== turn.effective.adapterId) {
    throw new Error(`Ready Role session identity changed: ${role.taskId}/${role.name}.`);
  }
  const compatible = mode === "resume"
    ? effectiveLaunchSnapshotsCompatibleForTaskSession(session.effective, turn.effective)
    : effectiveLaunchSnapshotsCompatible(session.effective, turn.effective);
  if (!compatible) {
    throw new Error(`Ready Role session effective snapshot changed: ${role.taskId}/${role.name}.`);
  }
  if (mode === "resume" && session.nativeSessionId !== existing?.nativeSessionId) {
    throw new Error(`Role resume changed the fixed native session id: ${role.taskId}/${role.name}.`);
  }
  return {
    ...session,
    status: "active",
    ...(mode === "resume" && existing !== null ? { effective: existing.effective } : {})
  };
}

function requireResumeSession(
  role: SchedulerRole,
  turn: SchedulerTurn,
  session: SchedulerRoleSession | null
): string {
  if (session === null || !hasText(session.nativeSessionId)) {
    throw new Error(`Role resume has no fixed native session: ${role.taskId}/${role.name}.`);
  }
  if (!effectiveLaunchSnapshotsCompatibleForTaskSession(session.effective, turn.effective)) {
    throw new Error(`Role resume effective snapshot drifted: ${role.taskId}/${role.name}.`);
  }
  return session.nativeSessionId;
}

function forget(
  delivery: TmuxDeliveryPort,
  taskId: string,
  roleName: string,
  turnId: string,
  launchId?: string
): void {
  delivery.forgetPrepared?.({
    taskId,
    roleName,
    turnId,
    ...(launchId === undefined ? {} : { launchId })
  });
}

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
