import { createAgentRun } from "../run/agentRun.js";
import {
  createRunAssignment,
  serializeRunBootstrapEnvelope
} from "../context/runContextContract.js";
import { formatAgentRunReceiptId } from "../task/taskRecordReference.js";
import {
  effectiveLaunchSnapshotsCompatible,
  effectiveLaunchSnapshotsCompatibleForTaskMain
} from "../executor/effectiveLaunch.js";
import {
  hasRuntimeLifecycleWork,
  RuntimeLifecycleBusyError,
  runtimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";
import { recordLeaderFailure } from "./leaderFailure.js";
import { createLeaderRecoveryNotification } from "./operatorNotification.js";
import type {
  PreparedRoleDelivery,
  SchedulerRole,
  SchedulerRoleSession,
  SchedulerReconcileSelection,
  SchedulerTask,
  SchedulerStorePort,
  TmuxDeliveryPort
} from "./ports.js";
import { isSchedulerTaskWorkspaceReady } from "./ports.js";
import type { RuntimeLaunchPreflight } from "../runtime/ports.js";
import { RuntimeLaunchError } from "../runtime/ports.js";

export type LeaderWakeupProcessingResult = Readonly<{
  taskId: string;
  runId?: string;
  status: "dispatched" | "skipped" | "failed";
  reason?: "busy" | "waiting-input" | "unavailable" | "workspace-not-ready" | "recovery-blocked" | "state-changed" | "not-ready" | "writer-attached" | "delivery-uncertain";
  error?: string;
}>;

export async function processLeaderWakeups(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  now: Date,
  selection?: SchedulerReconcileSelection
): Promise<LeaderWakeupProcessingResult[]> {
  const results: LeaderWakeupProcessingResult[] = [];
  const wakeups = selection === undefined || selection.full
    ? store.listPendingWakeups().filter((wakeup) => (
        !selection?.blockedTaskIds?.has(wakeup.taskId)
      ))
    : [...selection.taskIds].flatMap((taskId) => {
        if (selection.blockedTaskIds?.has(taskId)) return [];
        const wakeup = store.getPendingWakeup(taskId);
        return wakeup === null ? [] : [wakeup];
      });
  for (const wakeup of wakeups) {
    const task = store.getTask(wakeup.taskId);
    const role = store.getRole(wakeup.taskId, "leader");
    if (task === null || task.status !== "active" || role === null) {
      results.push({ taskId: wakeup.taskId, status: "skipped", reason: "unavailable" });
      continue;
    }
    const taskWorkspace = store.getTaskWorkspace(task.id);
    if (!isSchedulerTaskWorkspaceReady(task, taskWorkspace)) {
      results.push({ taskId: task.id, status: "skipped", reason: "workspace-not-ready" });
      continue;
    }
    if (store.getLeaderFailure(task.id) !== null) {
      results.push({ taskId: task.id, status: "skipped", reason: "recovery-blocked" });
      continue;
    }
    if (store.hasOpenInputRequest(task.id)) {
      results.push({ taskId: task.id, status: "skipped", reason: "waiting-input" });
      continue;
    }

    // This check deliberately precedes every tmux operation. A pending wake is
    // durable state, not text that may be injected into a busy Agent process.
    if (store.getActiveAgentRun(task.id, role.name) !== null) {
      results.push({ taskId: task.id, status: "skipped", reason: "busy" });
      continue;
    }
    if (typeof store.hasInFlightTurn === "function"
      && store.hasInFlightTurn(task.id, role.name)) {
      results.push({ taskId: task.id, status: "skipped", reason: "busy" });
      continue;
    }

    // Single-flight: a Role runtime lifecycle lane that already holds a
    // launch reservation or cleanup obligation must not be entered by a
    // second wake. The wake stays durable (pendingWakeup is not consumed) and
    // is retried after the lane settles; the suppression is recorded for the
    // audit instead of manufacturing a failed Run.
    if (hasRuntimeLifecycleWork(store.getWorkMailbox(runtimeLifecycleTarget({
      scope: "task",
      taskId: task.id,
      roleName: role.name
    })))) {
      store.recordWakeSuppression?.(task.id, "lifecycle-busy", now);
      results.push({ taskId: task.id, status: "skipped", reason: "recovery-blocked" });
      continue;
    }

    const reopening = wakeup.reasons.includes("task-reopened");
    let existingSession = store.getRoleSession(
      task.id,
      role.name,
      reopening ? undefined : role.effective.agentId
    );
    let effectiveSession: SchedulerRoleSession | null = existingSession;
    let claimed = false;
    let deliveryAttempted = false;
    let run: ReturnType<typeof createAgentRun> | null = null;
    let prepared: PreparedRoleDelivery | undefined;
    let preStartFencePersisted = false;
    try {
      if (existingSession !== null && !hasNativeSession(existingSession)) {
        const sessionIsTerminal = existingSession.status === "stopped"
          || existingSession.status === "broken";
        if (!sessionIsTerminal) {
          // An opaque live Session has no provider identity that can be safely
          // rebound. A host absence observation is not a verified stop; keep
          // the wake durable until an explicit exact cleanup/reset settles it.
          if (existingSession.launchId !== undefined) {
            await delivery.inspectRole({
              taskId: task.id,
              roleName: role.name,
              agentId: existingSession.agentId,
              adapterId: existingSession.adapterId
            });
          }
          results.push({
            taskId: task.id,
            status: "skipped",
            reason: "recovery-blocked"
          });
          continue;
        }
        if (hasRuntimeLifecycleWork(store.getWorkMailbox(runtimeLifecycleTarget({
          scope: "task",
          taskId: task.id,
          roleName: role.name
        })))) {
          // A stopped/broken Session is eligible for a fresh mode only after
          // its exact runtime cleanup/reservation lane has settled.
          results.push({
            taskId: task.id,
            status: "skipped",
            reason: "recovery-blocked"
          });
          continue;
        }
      }
      const compatibleSession = existingSession !== null
        && (reopening
          ? effectiveLaunchSnapshotsCompatible(existingSession.effective, role.effective)
          : effectiveLaunchSnapshotsCompatibleForTaskMain(
              existingSession.effective,
              role.effective,
              role.managedWorkspace
            ));
      const reopenIdentityDrift = reopening
        && hasNativeSession(existingSession)
        && !compatibleSession;
      if (hasNativeSession(existingSession) && !compatibleSession
        && !reopenIdentityDrift
        && existingSession.status !== "stopped" && existingSession.status !== "broken") {
        throw new Error(
          `Leader Session is incompatible with desired effective launch: ${task.id}/${role.name}.`
        );
      }
      const mode = hasNativeSession(existingSession) && compatibleSession ? "resume" : "new";
      const runId = store.peekNextAgentRunId(task.id);
      const wakeEnvelope = resolveLeaderWakeEnvelope(store, task.id);
      const contextSnapshot = store.freezeLeaderContextSnapshot?.(task.id, role.name, now);
      const assignment = createRunAssignment({
        runId,
        roleName: role.name,
        purpose: "execution",
        action: "leader-wake",
        subject: { taskId: task.id },
        directive: leaderWakeupInput(task.id, runId, wakeup.reasons),
        ...(contextSnapshot === undefined ? {} : { contextSnapshotRef: contextSnapshot.ref }),
        deltaRefIds: contextSnapshot?.deltaRefIds ?? []
      });
      run = createAgentRun(
        runId,
        task.id,
        role.name,
        mode,
        assignment,
        now,
        {
          ...(role.managedWorkspace === undefined
            ? {}
            : { workspace: role.managedWorkspace }),
          effective: role.effective
        }
      );
      const claim = store.saveLeaderDispatch({
        task,
        role,
        run,
        // An incompatible reopened generation is intentionally not rebound to
        // a new native host. Keep the old fixed Session as evidence while
        // claiming a short-lived Run so the existing failure path can record a
        // durable, retryable recovery obligation before any provider call.
        session: reopenIdentityDrift ? null : existingSession,
        wakeup,
        ...(wakeEnvelope === null ? {} : {
          wakeId: wakeEnvelope.wakeId,
          wakeFromCursor: wakeEnvelope.fromCursor
        }),
        now
      });
      if (claim !== "claimed") {
        results.push({ taskId: task.id, status: "skipped", reason: claim });
        continue;
      }
      claimed = true;
      if (reopenIdentityDrift) {
        throw new Error(
          `Leader reopen refused after effective launch identity drift: ${task.id}/${role.name}.`
        );
      }
      prepared = await delivery.prepareRoleSession({
        taskId: task.id,
        roleName: role.name,
        agentId: role.effective.agentId,
        adapterId: role.effective.adapterId,
        effective: role.effective,
        workspace: role.effective.workspace.root,
        ...(run.workspace === undefined
          ? {}
          : { managedWorkspace: run.workspace }),
        mode,
        runId: run.id,
        ...(mode === "resume" ? { nativeSessionId: existingSession!.nativeSessionId } : {}),
        beforeHostStart: (preflight) => {
          persistPreStartFence(
            store,
            task,
            role,
            run!,
            existingSession,
            mode,
            preflight,
            now
          );
          effectiveSession = preflightSession(
            role,
            run!.effective,
            existingSession,
            mode,
            preflight
          );
          preStartFencePersisted = true;
        }
      });
      // A managed host may already have submitted the exact Run prompt as
      // part of process launch. Once preparation returns that transport
      // fact, any
      // later readiness or aggregate-write failure is delivery uncertainty,
      // not a launch failure: preserve the Run and its reservation for the
      // matching provider Hook instead of terminalizing it.
      deliveryAttempted = prepared.inputSubmittedAtLaunch === true;
      // Persist the exact preparation fence before waiting on provider
      // readiness. A pre-input lifecycle Hook may fire during that wait; it
      // must be able to resolve this Run/Session/launch generation from durable
      // state rather than an in-memory delivery object. Fresh providers that
      // discover their native Session later intentionally persist `null`.
      if (!preStartFencePersisted) {
        const preparedFenceSession = prepared.session === undefined
          ? existingSession
          : validateReadySession(
              role,
              run.effective,
              existingSession,
              mode,
              prepared.session
            );
        effectiveSession = preparedFenceSession;
        store.saveRoleRunPrepared({
          task,
          role,
          run,
          session: preparedFenceSession,
          ...(prepared.launchId === undefined ? {} : { launchId: prepared.launchId }),
          now
        });
      }
      const ready = await delivery.waitUntilReady(prepared);
      deliveryAttempted = deliveryAttempted
        || ready.prepared.inputSubmittedAtLaunch === true;
      const latestTask = store.getTask(task.id);
      if (latestTask === null || latestTask.status !== "active") {
        delivery.forgetPrepared?.({
          taskId: task.id,
          roleName: role.name,
          runId: run.id,
          ...(prepared.launchId === undefined
            ? {}
            : { launchId: prepared.launchId })
        });
        results.push({ taskId: task.id, status: "skipped", reason: "unavailable" });
        continue;
      }
      effectiveSession = validateReadySession(
        role,
        run.effective,
        existingSession,
        mode,
        ready.session
      );
      store.saveRoleRunPrepared({
        task,
        role,
        run,
        session: effectiveSession,
        ...(ready.prepared.launchId === undefined
          ? {}
          : { launchId: ready.prepared.launchId }),
        now
      });
      if (ready.prepared.inputSubmittedAtLaunch === true) {
        // A fresh Codex command may carry the exact first prompt in its launch
        // argv. That is transport evidence only: the matching Provider Hook
        // still owns Run acceptance. Persist the push fence without writing a
        // second terminal prompt, then leave the reservation for the async
        // SessionStart/UserPromptSubmit fold.
        store.saveRoleRunDelivery({
          task,
          role,
          run,
          session: effectiveSession,
          ...(ready.prepared.launchId === undefined
            ? {}
            : { launchId: ready.prepared.launchId }),
          now
        });
        delivery.forgetPrepared?.({
          taskId: task.id,
          roleName: role.name,
          runId: run.id,
          ...(ready.prepared.launchId === undefined
            ? {}
            : { launchId: ready.prepared.launchId })
        });
        results.push({ taskId: task.id, runId: run.id, status: "dispatched" });
        continue;
      }
      deliveryAttempted = true;
      const outcome = await delivery.sendOnce({
        delivery: ready,
        receiptId: formatAgentRunReceiptId(task.id, run.id),
        text: serializeRunBootstrapEnvelope(run.bootstrapEnvelope)
      });
      if (outcome === "busy" || outcome === "unavailable") {
        results.push({
          taskId: task.id,
          runId: run.id,
          status: "skipped",
          reason: "not-ready"
        });
        continue;
      }

      store.saveRoleRunDelivery({
        task,
        role,
        run,
        session: effectiveSession,
        ...(ready.prepared.launchId === undefined
          ? {}
          : { launchId: ready.prepared.launchId }),
        now
      });
      results.push({ taskId: task.id, runId: run.id, status: "dispatched" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `Leader dispatch failed: ${detail}`;
      if (claimed && run !== null) {
        // Scheduler single-flight backpressure: the Role runtime lifecycle
        // lane was busy when the launch was reserved. The claimed Run stays
        // active-unpushed; the active-Run delivery path retries it after the
        // lane settles. This is contention before any semantic launch, not a
        // Run failure and not grounds for a Leader failure record.
        if (error instanceof RuntimeLifecycleBusyError) {
          delivery.forgetPrepared?.({
            taskId: task.id,
            roleName: role.name,
            runId: run.id
          });
          results.push({
            taskId: task.id,
            runId: run.id,
            status: "skipped",
            reason: "not-ready",
            error: message
          });
          continue;
        }
        // A finite managed provider from the preceding Run may still be
        // exiting after its durable yield. Keep this newly-claimed Run as the
        // sole owner of the Role mailbox; active-Run delivery will retry it
        // after the old host disappears. This is runtime backpressure, not a
        // Leader failure and not grounds for allocating another Run.
        if (error instanceof RuntimeLaunchError && error.retryable) {
          results.push({
            taskId: task.id,
            runId: run.id,
            status: "skipped",
            reason: error.reason === "writable-client"
              ? "writer-attached"
              : "not-ready",
            error: message
          });
          continue;
        }
        // Once delivery begins, a send may have succeeded even when receipt
        // observation or the aggregate write failed. Preserve the exact
        // durable Run and let receipt-backed active delivery recover it.
        if (deliveryAttempted) {
          results.push({
            taskId: task.id,
            runId: run.id,
            status: "failed",
            reason: "delivery-uncertain",
            error: message
          });
          continue;
        }
        delivery.forgetPrepared?.({
          taskId: task.id,
          roleName: role.name,
          runId: run.id,
          ...(prepared?.launchId === undefined
            ? {}
            : { launchId: prepared.launchId })
        });
        const failureResult = store.saveLeaderDispatchFailure({
          task,
          role,
          session: effectiveSession,
          claimed: { run, wakeup },
          failure: recordLeaderFailure(
            task.id,
            effectiveSession?.nativeSessionId ?? "(unregistered)",
            message,
            now,
            store.getLeaderFailure(task.id)
          ),
          notification: createLeaderRecoveryNotification(
            task.id,
            message,
            now,
            store.getOperatorNotification(task.id)
          ),
          now
        });
        if (failureResult === "state-changed") {
          results.push({ taskId: task.id, status: "skipped", reason: "state-changed" });
        } else {
          results.push({ taskId: task.id, runId: run.id, status: "failed", error: message });
        }
        continue;
      }
      results.push({
        taskId: task.id,
        runId: run?.id,
        status: "failed",
        reason: "not-ready",
        error: message
      });
    }
  }
  return results;
}

function validateReadySession(
  role: SchedulerRole,
  effective: import("../executor/effectiveLaunch.js").EffectiveLaunchSnapshot,
  existing: SchedulerRoleSession | null,
  mode: "new" | "resume",
  session: SchedulerRoleSession | null
): SchedulerRoleSession | null {
  if (mode === "new" && session === null) return null;
  if (session === null) throw new Error("Leader resume returned no fixed native session.");
  if (session.agentId !== effective.agentId || session.adapterId !== effective.adapterId) {
    throw new Error(`Ready session belongs to another Agent: ${session.agentId}.`);
  }
  const compatible = mode === "resume"
    ? effectiveLaunchSnapshotsCompatibleForTaskMain(
        session.effective,
        effective,
        role.managedWorkspace
      )
    : effectiveLaunchSnapshotsCompatible(session.effective, effective);
  if (!compatible) {
    throw new Error("Ready Leader session effective snapshot changed.");
  }
  if (!hasNativeSession(session)) {
    throw new Error("Ready Leader session has no native session id.");
  }
  if (mode === "resume" && session.nativeSessionId !== existing?.nativeSessionId) {
    throw new Error("Leader resume changed the fixed native session id.");
  }
  return {
    ...session,
    status: "running",
    ...(mode === "resume" && existing !== null
      ? { effective: existing.effective }
      : {})
  };
}

function persistPreStartFence(
  store: SchedulerStorePort,
  task: SchedulerTask,
  role: SchedulerRole,
  run: ReturnType<typeof createAgentRun>,
  existingSession: SchedulerRoleSession | null,
  mode: "new" | "resume",
  preflight: RuntimeLaunchPreflight,
  now: Date
): void {
  if (
    preflight.owner.scope !== "task"
    || preflight.owner.taskId !== task.id
    || preflight.owner.roleName !== role.name
    || preflight.runId !== run.id
    || preflight.launchId.trim().length === 0
  ) {
    throw new Error(`Pre-start launch fence changed the Leader Run: ${task.id}/${role.name}.`);
  }
  const session = preflightSession(role, run.effective, existingSession, mode, preflight);
  store.saveRoleRunPrepared({
    task,
    role,
    run,
    session,
    launchId: preflight.launchId,
    now
  });
}

function preflightSession(
  role: SchedulerRole,
  effective: import("../executor/effectiveLaunch.js").EffectiveLaunchSnapshot,
  existing: SchedulerRoleSession | null,
  mode: "new" | "resume",
  preflight: RuntimeLaunchPreflight
): SchedulerRoleSession | null {
  const session = preflight.nativeSessionId === undefined
    ? null
    : {
        agentId: preflight.agentId,
        adapterId: preflight.adapterId,
        nativeSessionId: preflight.nativeSessionId,
        launchId: preflight.launchId,
        status: "ready" as const,
        effective: preflight.effective
      };
  return validateReadySession(role, effective, existing, mode, session);
}

function hasNativeSession(
  session: SchedulerRoleSession | null
): session is SchedulerRoleSession & { nativeSessionId: string } {
  return session !== null &&
    typeof session.nativeSessionId === "string" &&
    session.nativeSessionId.trim().length > 0;
}

/**
 * Issue 04 (long-term design): resolves the minimal wake envelope for a
 * Leader wake. The envelope carries only the aggregated reason tags, the
 * delta window, and read pointers; the Agent reads delta content on demand
 * with `yui task wake show`. Returns null when the adapter lacks the
 * projection, so the wake falls back to the full `yui task context`
 * instruction.
 */
function resolveLeaderWakeEnvelope(
  store: SchedulerStorePort,
  taskId: string
): import("../context/wakeNotification.js").WakeEnvelope | null {
  if (typeof store.getTaskWakeEnvelope !== "function") return null;
  return store.getTaskWakeEnvelope(taskId);
}

function leaderWakeupInput(
  taskId: string,
  runId: string,
  reasons: readonly string[]
): string {
  return [
    `For every Leader decision, milestone, or Work Item lifecycle command that is meaningful progress, carry this exact current-turn assertion on that command: YUI_LEADER_ACTION_RUN_ID=${runId} YUI_LEADER_ACTION_RECEIPT_ID=${formatAgentRunReceiptId(taskId, runId)}. The native Session environment may retain an older YUI_RUN_ID/launch; never copy those values, and never reuse this assertion after the turn changes.`,
    `Wake reasons: ${reasons.join(", ")}. Load exact context for ${taskId}/${runId}.`
  ].join("\n");
}
