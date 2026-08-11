import { createAgentRun } from "../run/agentRun.js";
import { markYuiRunInput } from "../run/runIdentity.js";
import { taskRoleSessionTitle } from "../runtime/sessionTitle.js";
import { formatAgentRunReceiptId } from "../task/taskRecordReference.js";
import { effectiveLaunchSnapshotsCompatible } from "../executor/effectiveLaunch.js";
import {
  hasRuntimeLifecycleWork,
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
import type { RuntimeLaunchPreflight } from "../runtime/ports.js";

export type LeaderWakeupProcessingResult = Readonly<{
  taskId: string;
  runId?: string;
  status: "dispatched" | "skipped" | "failed";
  reason?: "busy" | "waiting-input" | "unavailable" | "workspace-not-ready" | "recovery-blocked" | "state-changed" | "not-ready" | "delivery-uncertain";
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
    ? store.listPendingWakeups()
    : [...selection.taskIds].flatMap((taskId) => {
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
    if (task.projectBindings.length > 0 && task.cwd === undefined) {
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

    const reopening = wakeup.reasons.includes("task-reopened");
    const existingSession = store.getRoleSession(
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
        && effectiveLaunchSnapshotsCompatible(existingSession.effective, role.effective);
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
      const input = markYuiRunInput(leaderWakeupInput(
        task.id,
        runId,
        wakeup.reasons,
        task.projectBindings
      ), runId, taskRoleSessionTitle(task, role.name));
      run = createAgentRun(
        runId,
        task.id,
        role.name,
        mode,
        input,
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
            run!.effective,
            existingSession,
            mode,
            preflight
          );
          preStartFencePersisted = true;
        }
      });
      // A fresh Codex host may already carry the exact Run prompt in its
      // launch argv. Once preparation returns that transport fact, any
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
        text: input
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
  if (!effectiveLaunchSnapshotsCompatible(session.effective, effective)) {
    throw new Error("Ready Leader session effective snapshot changed.");
  }
  if (!hasNativeSession(session)) {
    throw new Error("Ready Leader session has no native session id.");
  }
  if (mode === "resume" && session.nativeSessionId !== existing?.nativeSessionId) {
    throw new Error("Leader resume changed the fixed native session id.");
  }
  return { ...session, status: "running" };
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
  const session = preflightSession(run.effective, existingSession, mode, preflight);
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
  return validateReadySession(effective, existing, mode, session);
}

function hasNativeSession(
  session: SchedulerRoleSession | null
): session is SchedulerRoleSession & { nativeSessionId: string } {
  return session !== null &&
    typeof session.nativeSessionId === "string" &&
    session.nativeSessionId.trim().length > 0;
}

function leaderWakeupInput(
  taskId: string,
  runId: string,
  reasons: readonly string[],
  projectBindings: readonly Readonly<{ projectId: string; directory: string }>[]
): string {
  const lines: string[] = [
    "Follow the injected yui-leader Skill for this Yui wakeup.",
    `Current Leader Run: ${runId}.`,
    `For every Leader decision, milestone, or Work Item lifecycle command that is meaningful progress, carry this exact current-turn assertion on that command: YUI_LEADER_ACTION_RUN_ID=${runId} YUI_LEADER_ACTION_RECEIPT_ID=${formatAgentRunReceiptId(taskId, runId)}. The native Session environment may retain an older YUI_RUN_ID/launch; never copy those values, and never reuse this assertion after the turn changes.`,
    `Yui wakeup reasons: ${reasons.join(", ")}.`,
    `Read the authoritative context with yui task context ${taskId}.`,
    "Keep the context layers separate: Yui Core owns durable identity, lifecycle, access, workspace, and exact-yield safety; the generic role Skill owns portable collaboration behavior; Project Policy/Knowledge owns project-specific build, test, migration, release, and review rules; the Task Contract owns this Task's objective, scope, acceptance, and evidence.",
    "For role-run-stalled or runtime-health attention, diagnose from the exact Run/Event/Session and related WorkItem/Review/Integration records. Preserve the current fence and write a Task Message only for a new root cause, impact, recovery action, acceptance decision, or user-relevant conclusion; an unchanged healthy wait is zero Message.",
    projectBindings.length === 0
      ? "This Task has no bound Project Policy; do not invent repository-specific rules."
      : `Project Policy references: ${projectBindings.map((binding) => `${binding.directory} (${binding.projectId})`).join(", ")}. Read each with yui project show <project>, then yui project knowledge list <project> and yui project knowledge show <project> <knowledge>.`,
    "Use narrower Task message, WorkItem, decision, milestone, and input commands only when a specific record needs closer inspection.",
    `When the requested outcome is finished and there are no active Worker Runs or unresolved inputs, complete the Task with yui task complete ${taskId} --summary-file - and a quoted heredoc containing the final outcome and evidence.`,
    `Before ending this turn, if the Task was not completed and no InputRequest terminalized this Run, release the active fence with yui task run yield ${runId} --summary-file - and a quoted heredoc containing the current result or waiting state. In particular, yield before waiting for Worker results; do not end the native turn while this Run remains active. The yield command must be the final tool action: after it succeeds, stop immediately and do not inspect, poll, accept, or perform further work in the same native turn.`
  ];
  return lines.join("\n");
}
