import {
  createTurnInput,
  type TurnInputSource
} from "../context/turnInputContract.js";
import {
  effectiveLaunchSnapshotsCompatible,
  effectiveLaunchSnapshotsCompatibleForTaskSession
} from "../executor/effectiveLaunch.js";
import { roleAgentSessionResumeMode } from "../executor/agentExecutor.js";
import { createTurn } from "../turn/turn.js";
import type {
  SchedulerReconcileSelection,
  SchedulerRoleSession,
  SchedulerStorePort,
  TmuxDeliveryPort
} from "./ports.js";
import { isSchedulerTaskWorkspaceReady } from "./ports.js";

export type LeaderWakeupProcessingResult = Readonly<{
  taskId: string;
  turnId?: string;
  status: "dispatched" | "steered" | "skipped" | "failed";
  reason?: "aggregating" | "busy" | "waiting-input" | "unavailable" | "workspace-not-ready" | "state-changed" | "not-ready";
  error?: string;
}>;

export const LEADER_WAKE_AGGREGATION_MS = 60_000;
export const LEADER_WAKE_FORCE_MS = 10 * 60_000;

/**
 * Materializes durable Leader intent as a Turn. Provider lifecycle and
 * Turn submission are handled by processActiveRoleTurnDeliveries, so every
 * Role follows one launch, serialization, and failure path.
 */
export async function processLeaderWakeups(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  now: Date,
  selection?: SchedulerReconcileSelection
): Promise<LeaderWakeupProcessingResult[]> {
  const results: LeaderWakeupProcessingResult[] = [];
  const wakeups = selection === undefined || selection.full
    ? store.listPendingWakeups().filter((wakeup) => !selection?.blockedTaskIds?.has(wakeup.taskId))
    : [...selection.taskIds].flatMap((taskId) => {
        if (selection.blockedTaskIds?.has(taskId)) return [];
        const wakeup = store.getPendingWakeup(taskId);
        return wakeup === null ? [] : [wakeup];
      });

  for (const wakeup of wakeups) {
    const task = store.getTask(wakeup.taskId);
    const role = store.getRole(wakeup.taskId, "leader");
    if (task === null
      || task.status !== "active"
      || task.executionGate.state !== "enabled"
      || role === null) {
      results.push({ taskId: wakeup.taskId, status: "skipped", reason: "unavailable" });
      continue;
    }
    if (!isSchedulerTaskWorkspaceReady(task, store.getTaskWorkspace(task.id))) {
      results.push({ taskId: task.id, status: "skipped", reason: "workspace-not-ready" });
      continue;
    }
    if (store.hasOpenInputRequest(task.id)) {
      results.push({ taskId: task.id, status: "skipped", reason: "waiting-input" });
      continue;
    }
    const waitedMs = Math.max(0, now.getTime() - Date.parse(wakeup.firstRequestedAt));
    if (waitedMs < LEADER_WAKE_AGGREGATION_MS) {
      results.push({ taskId: task.id, status: "skipped", reason: "aggregating" });
      continue;
    }
    const active = store.getActiveTurn(task.id, role.name);
    const leaderTarget = { kind: "role", taskId: task.id, roleName: role.name } as const;
    const claimedSteer = store.getWorkMailbox(leaderTarget)?.processing;
    if (claimedSteer?.owner.startsWith("leader-steer:") === true
      && (active === null || claimedSteer.owner !== `leader-steer:${active.id}`)) {
      store.releaseWorkMailbox(leaderTarget, claimedSteer.batchId);
      results.push({ taskId: task.id, status: "skipped", reason: "state-changed" });
      continue;
    }
    if (active !== null) {
      if (waitedMs >= LEADER_WAKE_FORCE_MS && active !== null) {
        results.push(await forceLeaderSteer(store, delivery, task.id, role.name, active, now));
        continue;
      }
      results.push({ taskId: task.id, status: "skipped", reason: "busy" });
      continue;
    }

    try {
      const reopening = wakeup.reasons.includes("task-reopened");
      const existingSession = store.getRoleSession(
        task.id,
        role.name,
        reopening ? undefined : role.effective.agentId
      );
      const compatible = existingSession !== null && (reopening
        ? effectiveLaunchSnapshotsCompatible(existingSession.effective, role.effective)
        : effectiveLaunchSnapshotsCompatibleForTaskSession(existingSession.effective, role.effective));
      if (hasNativeSession(existingSession)
        && existingSession.status === "active"
        && !compatible
        && !reopening) {
        throw new Error(`Leader Session is incompatible with desired effective launch: ${task.id}/${role.name}.`);
      }

      const sessionSet = store.getTaskRoleSessionSet?.(task.id, role.name) ?? null;
      const mode = reopening && !compatible
        ? "new" as const
        : sessionSet === null
          ? hasNativeSession(existingSession) && existingSession.status === "active" && compatible
            ? "resume" as const
            : "new" as const
          : roleAgentSessionResumeMode(sessionSet, role.effective.agentId, role.effective);
      const turnId = store.peekNextTurnId(task.id);
      const contextSnapshot = store.freezeLeaderContextSnapshot?.(task.id, role.name, now);
      const input = createTurnInput({
        source: leaderWakeInputSource(wakeup.reasons),
        directive: [
          `Wake reasons: ${wakeup.reasons.join(", ")}.`,
          `Load exact context for ${task.id}/${turnId}.`,
          "Before ending this Turn, judge the affected WorkItems and Task; persist any lifecycle or result changes you establish.",
          "The final Turn response is evidence only and never updates WorkItem or Task state by itself."
        ].join(" "),
        ...(contextSnapshot === undefined ? {} : { contextSnapshotRef: contextSnapshot.ref }),
        deltaRefIds: contextSnapshot?.deltaRefIds ?? []
      });
      const turn = createTurn(turnId, task.id, role.name, mode, input, now, {
        ...(role.managedWorkspace === undefined ? {} : { workspace: role.managedWorkspace }),
        effective: role.effective
      });
      const envelope = store.getTaskWakeEnvelope?.(task.id) ?? null;
      const claim = store.saveLeaderDispatch({
        task,
        role,
        turn,
        session: reopening && !compatible ? null : existingSession,
        wakeup,
        ...(envelope === null ? {} : {
          wakeId: envelope.wakeId,
          wakeFromCursor: envelope.fromCursor
        }),
        now
      });
      results.push(claim === "claimed"
        ? { taskId: task.id, turnId: turn.id, status: "dispatched" }
        : { taskId: task.id, status: "skipped", reason: claim });
    } catch (error) {
      results.push({
        taskId: task.id,
        status: "failed",
        reason: "not-ready",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}

function leaderWakeInputSource(reasons: readonly string[]): TurnInputSource {
  if (reasons.length > 0 && reasons.every((reason) => reason === "user-message")) {
    return { type: "yui", channel: "user-message" };
  }
  if (reasons.length > 0 && reasons.every((reason) => reason.startsWith("input-answered:"))) {
    return { type: "yui", channel: "input-response" };
  }
  return { type: "yui", channel: "leader-wakeup" };
}

async function forceLeaderSteer(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  taskId: string,
  roleName: string,
  active: import("../turn/turn.js").Turn,
  now: Date
): Promise<LeaderWakeupProcessingResult> {
  const target = { kind: "role", taskId, roleName } as const;
  const mailbox = store.getWorkMailbox(target);
  const pending = mailbox?.pending;
  const existing = mailbox?.processing;
  if (existing === null || existing === undefined) {
    if (pending === null || pending === undefined) {
      return { taskId, turnId: active.id, status: "skipped", reason: "state-changed" };
    }
  }
  const owner = `leader-steer:${active.id}`;
  const batchId = existing?.batchId
    ?? `leader-steer:${encodeURIComponent(taskId)}:${encodeURIComponent(active.id)}:${pending!.fromSequence}-${pending!.toSequence}`;
  const claim = store.claimWorkMailbox({ target, batchId, owner, now });
  if (claim.status === "empty") {
    return { taskId, turnId: active.id, status: "skipped", reason: "state-changed" };
  }
  const processing = claim.processing;
  if (processing.batchId !== batchId || processing.owner !== owner) {
    return { taskId, turnId: active.id, status: "skipped", reason: "busy" };
  }
  const sessions = store.getTaskRoleSessionSet?.(taskId, roleName) ?? null;
  const session = sessions?.sessions[active.effective.agentId];
  const binding = sessions?.providerBinding;
  const providerTurn = binding?.turn;
  const authority = binding?.authority;
  if (session?.launchId === undefined || session.nativeSessionId === undefined
    || providerTurn === null || providerTurn === undefined
    || providerTurn.turnId !== active.id || providerTurn.nativeTurnId === undefined
    || providerTurn.status !== "accepted"
    || authority?.owner !== "controller" || authority.holderId === undefined) {
    store.releaseWorkMailbox(target, batchId);
    return { taskId, status: "failed", reason: "not-ready", error: "Active Leader Turn has no steerable Provider fence." };
  }
  const batch = processing.batch;
  const directive = [
    `Aggregated Leader events: ${batch.reasons.join(", ")}.`,
    `The first event arrived at ${batch.firstQueuedAt} and has waited at least 10 minutes while this Leader Turn remained active.`,
    "Process these events now and update durable Task or WorkItem facts when needed.",
    "After the events are handled, continue the work you were doing before this interruption.",
    `Load the current exact context for ${taskId}/${active.id}; the event batch may have grown while this input was delivered.`
  ].join(" ");
  const input = createTurnInput({
    source: { type: "yui", channel: "leader-forced-wakeup" },
    directive,
    deltaRefIds: []
  });
  const outcome = await delivery.steerOnce({
    taskId,
    roleName,
    agentId: active.effective.agentId,
    adapterId: active.effective.adapterId,
    launchId: session.launchId,
    nativeSessionId: session.nativeSessionId,
    nativeTurnId: providerTurn.nativeTurnId,
    authority: {
      epoch: authority.epoch,
      owner: "controller",
      holderId: authority.holderId
    },
    receiptId: `turn-input:${taskId}/${active.id}/${batchId}`,
    text: directive
  });
  if (outcome !== "sent" && outcome !== "already-sent") {
    if (outcome !== "delivery-unknown") store.releaseWorkMailbox(target, batchId);
    return {
      taskId,
      turnId: active.id,
      status: outcome === "busy" ? "skipped" : "failed",
      reason: outcome === "busy" ? "busy" : "not-ready",
      error: outcome
    };
  }
  const saved = store.saveLeaderSteer({ taskId, turnId: active.id, batchId, input, now });
  if (saved !== "claimed") store.releaseWorkMailbox(target, batchId);
  return saved === "claimed"
    ? { taskId, turnId: active.id, status: "steered" }
    : { taskId, turnId: active.id, status: "skipped", reason: saved };
}


function hasNativeSession(
  session: SchedulerRoleSession | null
): session is SchedulerRoleSession & { nativeSessionId: string } {
  return session !== null
    && typeof session.nativeSessionId === "string"
    && session.nativeSessionId.trim().length > 0;
}
