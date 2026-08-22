import type {
  PreparedRoleDelivery,
  SchedulerAgentRun,
  RoleRunDeliveryFailurePersistence,
  SchedulerRole,
  SchedulerTask,
  SchedulerRoleSession,
  SchedulerStorePort,
  TmuxDeliveryPort
} from "./ports.js";
import {
  selectedSchedulerRoles,
  selectedActiveSchedulerTasks,
  type SchedulerReconcileSelection
} from "./ports.js";
import { isSchedulerTaskWorkspaceReady } from "./ports.js";
import { formatAgentRunReceiptId } from "../task/taskRecordReference.js";
import { markYuiRunInput } from "../run/runIdentity.js";
import { taskRoleSessionTitle } from "../runtime/sessionTitle.js";
import {
  effectiveLaunchSnapshotsCompatible,
  effectiveLaunchSnapshotsCompatibleForTaskMain
} from "../executor/effectiveLaunch.js";
import { RuntimeLaunchError } from "../runtime/ports.js";
import { RuntimeLaunchFailure } from "../runtime/launchDiagnostics.js";
import { builtinAgentDriverRegistry } from "../runtime/builtinAgentDrivers.js";
import type { RuntimeLaunchPreflight } from "../runtime/ports.js";
import { mailboxHasWork, nextPendingBatch } from "../coordination/workMailbox.js";
import { runtimeObservationFromTaskEvent } from "../runtime/runtimeObservation.js";
import { projectProviderContinuations } from "../runtime/runtimeContinuationProjection.js";
import {
  hasRuntimeLifecycleWork,
  RuntimeLifecycleBusyError,
  runtimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";

export type ActiveRoleRunDeliveryResult = Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
  status: "delivered" | "already-delivered" | "skipped" | "failed";
  reason?: "workspace-not-ready" | "launch-failed" | "generation-lost" | "mailbox-empty" | "mailbox-busy" | "not-ready" | "runtime-unavailable" | "writer-attached" | "delivery-uncertain" | "delivery-unsupported";
  error?: string;
  terminalFailure?: Omit<RoleRunDeliveryFailurePersistence, "now">;
  terminalized?: boolean;
}>;

/**
 * Delivers durable Work AgentRuns before liveness reconciliation. Task command
 * handlers only record intent; this Controller path is the sole automated
 * route into the Agent terminal, through tmux receipt-backed delivery.
 */
export async function processActiveRoleRunDeliveries(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  now: Date,
  selection?: SchedulerReconcileSelection,
  inputDeliveryRecoveryCutoff?: Date
): Promise<ActiveRoleRunDeliveryResult[]> {
  const results: ActiveRoleRunDeliveryResult[] = [];
  for (const task of selectedActiveSchedulerTasks(store, selection)) {
    for (const role of selectedSchedulerRoles(store, task.id, selection)) {
      const run = store.getActiveAgentRun(task.id, role.name);
      if (run !== null && run.pushedAt !== undefined) {
        const continuation = await processActiveRunContinuation(
          store,
          delivery,
          task,
          role,
          run,
          now,
          inputDeliveryRecoveryCutoff
        );
        if (continuation !== null) results.push(continuation);
        continue;
      }
      // A crash after a Leader wake is durably claimed but before tmux input
      // is recoverable through the same receipt-backed delivery path. The
      // re-push guard keys on pushedAt (transport), not deliveredAt (provider
      // acceptance): a pushed-but-unaccepted Run must never be pushed twice —
      // no duplicate Enter while acceptance is still pending.
      if (run === null || run.pushedAt !== undefined) continue;
      const taskWorkspace = store.getTaskWorkspace(task.id);
      if (!isSchedulerTaskWorkspaceReady(task, taskWorkspace)) {
        results.push({
          taskId: task.id,
          roleName: role.name,
          runId: run.id,
          status: "skipped",
          reason: "workspace-not-ready"
        });
        continue;
      }

      // Single-flight: a Role runtime lifecycle lane that already holds a
      // launch reservation or cleanup obligation must not be entered by a
      // second delivery. The Run stays active-unpushed and is retried after
      // the lane settles; the contention is never terminalized as a failure.
      if (hasRuntimeLifecycleWork(store.getWorkMailbox(runtimeLifecycleTarget({
        scope: "task",
        taskId: task.id,
        roleName: role.name
      })))) {
        results.push({
          taskId: task.id,
          roleName: role.name,
          runId: run.id,
          status: "skipped",
          reason: "runtime-unavailable"
        });
        continue;
      }

      const existingSession = store.getRoleSession(
        task.id,
        role.name,
        run.effective.agentId
      );
      const receiptId = formatAgentRunReceiptId(task.id, run.id);
      const target = { kind: "role", taskId: task.id, roleName: role.name } as const;
      const claim = store.claimWorkMailbox({
        target,
        batchId: receiptId,
        owner: "controller",
        now,
        executionRef: { type: "run", taskId: task.id, id: run.id }
      });
      if (claim.status === "empty") {
        results.push({
          taskId: task.id,
          roleName: role.name,
          runId: run.id,
          status: "skipped",
          reason: "mailbox-empty"
        });
        continue;
      }
      const processing = claim.processing;
      if (
        processing.executionRef?.type !== "run"
        || processing.executionRef.taskId !== task.id
        || processing.executionRef.id !== run.id
      ) {
        results.push({
          taskId: task.id,
          roleName: role.name,
          runId: run.id,
          status: "skipped",
          reason: "mailbox-busy"
        });
        continue;
      }
      let prepared: PreparedRoleDelivery | undefined;
      let preparedSession: SchedulerRoleSession | null = existingSession;
      let preStartFencePersisted = false;
      let deliveryAttempted = false;
      try {
        const nativeSessionId = run.mode === "resume"
          ? requireResumeSession(role, run.effective, existingSession)
          : undefined;
        prepared = await delivery.prepareRoleSession({
          taskId: task.id,
          roleName: role.name,
          agentId: run.effective.agentId,
          adapterId: run.effective.adapterId,
          effective: run.effective,
          workspace: run.effective.workspace.root,
          ...(run.workspace === undefined
            ? {}
            : { managedWorkspace: run.workspace }),
          mode: run.mode,
          runId: run.id,
          ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
          beforeHostStart: (preflight) => {
            persistPreStartFence(
              store,
              task,
              role,
              run,
              existingSession,
              preflight,
              now
            );
            preparedSession = preflightSession(
              role,
              run.effective,
              existingSession,
              run.mode,
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
        // Preparation may already have an exact native Session identity while
        // the provider is still starting. Persist that Session + the Run fence
        // before awaiting readiness so a pre-input provider Hook can validate
        // the complete generation (including receipt) instead of racing an
        // in-memory boundary. A delivery adapter that cannot expose a
        // pre-readiness Session falls back to the existing durable Session;
        // fresh runtime-discovered providers intentionally persist `null`.
        if (!preStartFencePersisted) {
          const preparedFenceSession = validateLaunchSubmittedRecoverySession(
            role,
            run.effective,
            existingSession,
            run.mode,
            prepared,
            prepared.session
          );
          preparedSession = preparedFenceSession;
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
        const session = validateLaunchSubmittedRecoverySession(
          role,
          run.effective,
          existingSession,
          run.mode,
          ready.prepared,
          ready.session
        );
        preparedSession = session;
        store.saveRoleRunPrepared({
          task,
          role,
          run,
          session,
          ...(ready.prepared.launchId === undefined
            ? {}
            : { launchId: ready.prepared.launchId }),
          now
        });
        if (ready.prepared.inputSubmittedAtLaunch === true) {
          // The exact Run prompt was already carried by the newly-created
          // Provider command. Persist transport success without writing any
          // terminal bytes; only the later matching Provider Hook may mark
          // the Run delivered/accepted.
          store.saveRoleRunDelivery({
            task,
            role,
            run,
            session,
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
          results.push({
            taskId: task.id,
            roleName: role.name,
            runId: run.id,
            status: "delivered"
          });
          continue;
        }
        // Pre-input readiness gate. For an adapter whose capability proves a
        // native event fires before the first prompt (e.g. Claude SessionStart),
        // a freshly-started host must not be pushed until that provider-ready
        // fact has been folded. Unsupported adapters (e.g. Codex) have no
        // pre-input event, so their push proceeds and acceptance is confirmed
        // only by the later exact provider-accepted fold. The gate reads the
        // adapter capability and the durable ready projection — never a sleep,
        // screen scrape, or pane/PID inference — and fails closed for a
        // supported adapter whose readiness cannot be confirmed.
        if (
          ready.prepared.sessionStarted
          && builtinAgentDriverRegistry().requireByAdapterId(run.effective.adapterId)
            .capabilities.observation.preInputReadiness === "exact"
          && !providerReadyForPush(store, {
            taskId: task.id,
            roleName: role.name,
            agentId: run.effective.agentId,
            ...(ready.prepared.launchId === undefined ? {} : { launchId: ready.prepared.launchId }),
            ...(session?.nativeSessionId === undefined
              ? {}
              : { nativeSessionId: session.nativeSessionId })
          })
        ) {
          results.push({
            taskId: task.id,
            roleName: role.name,
            runId: run.id,
            status: "skipped",
            reason: "not-ready"
          });
          continue;
        }
        deliveryAttempted = true;
        const outcome = await delivery.sendOnce({
          delivery: ready,
          receiptId,
          text: run.input
        });
        if (outcome === "busy" || outcome === "unavailable") {
          results.push({
            taskId: task.id,
            roleName: role.name,
            runId: run.id,
            status: "skipped",
            reason: outcome === "busy" ? "not-ready" : "runtime-unavailable",
            terminalFailure: roleRunDeliveryFailure(
              run,
              processing.batchId,
              session,
              ready.prepared.launchId
            )
          });
          continue;
        }
        const status = outcome === "sent" ? "delivered" : "already-delivered";
        store.saveRoleRunDelivery({
          task,
          role,
          run,
          session,
          ...(ready.prepared.launchId === undefined
            ? {}
            : { launchId: ready.prepared.launchId }),
          now
        });
        results.push({ taskId: task.id, roleName: role.name, runId: run.id, status });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Scheduler single-flight backpressure: the Role runtime lifecycle
        // lane was busy when the launch was reserved. The Run stays
        // active-unpushed and its mailbox claim is retained; the next pass
        // retries after the lane settles. This is contention before any
        // semantic launch, never a Run failure.
        if (error instanceof RuntimeLifecycleBusyError) {
          delivery.forgetPrepared?.({
            taskId: task.id,
            roleName: role.name,
            runId: run.id
          });
          results.push({
            taskId: task.id,
            roleName: role.name,
            runId: run.id,
            status: "skipped",
            reason: "runtime-unavailable",
            error: message
          });
          continue;
        }
        if (error instanceof RuntimeLaunchFailure) {
          if (!deliveryAttempted) {
            delivery.forgetPrepared?.({
              taskId: task.id,
              roleName: role.name,
              runId: run.id,
              ...(prepared?.launchId === undefined
                ? {}
                : { launchId: prepared.launchId })
            });
            const persisted = store.saveExitedRoleRun({
              task,
              role,
              run,
              session: existingSession,
              summary: error.message,
              now
            });
            results.push({
              taskId: task.id,
              roleName: role.name,
              runId: run.id,
              status: "failed",
              reason: "launch-failed",
              error: persisted === "state-changed"
                ? "Run state changed during launch failure."
                : message,
              terminalized: persisted === "failed"
            });
            continue;
          }
        }
        if (error instanceof RuntimeLaunchError) {
          const terminalFailure = roleRunDeliveryFailure(
            run,
            processing.batchId,
            existingSession,
            error.launchId
          );
          if (error.retryable) {
            const writerAttached = error.reason === "writable-client";
            results.push({
              taskId: task.id,
              roleName: role.name,
              runId: run.id,
              status: "skipped",
              reason: writerAttached ? "writer-attached" : "runtime-unavailable",
              error: message,
              ...(writerAttached ? {} : { terminalFailure })
            });
            continue;
          }
          const persisted = store.saveRoleRunDeliveryFailure({
            ...terminalFailure,
            now
          });
          if (persisted === "failed") {
            delivery.forgetPrepared?.({
              taskId: task.id,
              roleName: role.name,
              runId: run.id,
              launchId: error.launchId
            });
          }
          results.push({
            taskId: task.id,
            roleName: role.name,
            runId: run.id,
            status: "failed",
            reason: "generation-lost",
            error: persisted === "state-changed"
              ? "Run state changed during exact launch generation failure."
              : message,
            terminalized: persisted === "failed"
          });
          continue;
        }
        if (!deliveryAttempted) {
          delivery.forgetPrepared?.({
            taskId: task.id,
            roleName: role.name,
            runId: run.id,
            ...(prepared?.launchId === undefined
              ? {}
              : { launchId: prepared.launchId })
          });
          const persisted = store.saveExitedRoleRun({
            task,
            role,
            run,
            session: existingSession,
            summary: `Role Run could not start: ${message}`,
            now
          });
          results.push({
            taskId: task.id,
            roleName: role.name,
            runId: run.id,
            status: "failed",
            reason: "launch-failed",
            error: persisted === "state-changed" ? "Run state changed during launch failure." : message,
            terminalized: persisted === "failed"
          });
          continue;
        }
        results.push({
          taskId: task.id,
          roleName: role.name,
          runId: run.id,
          status: "failed",
          reason: "delivery-uncertain",
          error: message,
          terminalFailure: roleRunDeliveryFailure(
            run,
            processing.batchId,
            preparedSession,
            prepared?.launchId
          )
        });
      }
    }
  }
  return results;
}

async function processActiveRunContinuation(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  task: SchedulerTask,
  role: SchedulerRole,
  run: SchedulerAgentRun,
  now: Date,
  inputDeliveryRecoveryCutoff?: Date
): Promise<ActiveRoleRunDeliveryResult | null> {
  const target = { kind: "role", taskId: task.id, roleName: role.name } as const;
  const mailbox = store.getWorkMailbox(target);
  if (mailbox === null || !mailboxHasWork(mailbox)) return null;
  const session = store.getRoleSession(task.id, role.name, run.effective.agentId);
  if (session === null || session.launchId === undefined || !hasText(session.nativeSessionId)) {
    return {
      taskId: task.id,
      roleName: role.name,
      runId: run.id,
      status: "skipped",
      reason: "not-ready"
    };
  }

  const originalReceipt = formatAgentRunReceiptId(task.id, run.id);
  if (mailbox.processing !== null && (
    mailbox.processing.executionRef?.type !== "run"
    || mailbox.processing.executionRef.taskId !== task.id
    || mailbox.processing.executionRef.id !== run.id
    || mailbox.processing.batchId !== originalReceipt
  )) {
    return {
      taskId: task.id,
      roleName: role.name,
      runId: run.id,
      status: "skipped",
      reason: "mailbox-busy"
    };
  }
  if (mailbox.inputDelivery !== null) {
    const existing = mailbox.inputDelivery;
    if ((existing.status === "delivery-unknown"
      || (existing.status === "dispatching"
        && inputDeliveryRecoveryCutoff !== undefined
        && Date.parse(existing.startedAt) < inputDeliveryRecoveryCutoff.getTime()))) {
      return reconcileStrandedInputDelivery(
        store,
        delivery,
        task,
        role,
        run,
        session,
        existing,
        now
      );
    }
    return {
      taskId: task.id,
      roleName: role.name,
      runId: run.id,
      status: "skipped",
      reason: "delivery-uncertain"
    };
  }
  const pending = nextPendingBatch(mailbox);
  const lane = mailbox.pending.userCorrection === pending ? "user-correction" : "normal";
  const requestedBatchId = pending === null
    ? originalReceipt
    : `agent-input:${task.id}/${run.id}/${lane}:${pending.fromSequence}-${pending.toSequence}`;
  if (requestedBatchId === originalReceipt) {
    // Initial provider acceptance is still outstanding. It owns this claim;
    // never reinterpret the original Run prompt as a continuation.
    return {
      taskId: task.id,
      roleName: role.name,
      runId: run.id,
      status: "skipped",
      reason: "delivery-uncertain"
    };
  }
  if (pending === null || session.launchId === undefined) return null;
  if (session.status === "broken") {
    return {
      taskId: task.id,
      roleName: role.name,
      runId: run.id,
      status: "skipped",
      reason: "runtime-unavailable"
    };
  }
  const activeTurn = store.getActiveProviderTurnFence?.({
    taskId: task.id,
    roleName: role.name,
    runId: run.id,
    agentId: run.effective.agentId,
    launchId: session.launchId,
    nativeSessionId: session.nativeSessionId!
  }) ?? null;
  const mode = lane === "user-correction"
    ? activeTurn !== null && delivery.canRouteProviderInput?.(run.effective.adapterId) === true
      ? "steer-if-safe"
      : "followup"
    : pending.deliveryModes.includes("followup") ? "followup" : "inject";
  // Normal facts never enter an active Turn. A user correction may steer only
  // through the exact Turn fence above; without it, retain the high-priority
  // lane until the current Turn ends and deliver it as the next followup.
  if (mode === "followup" && session.status === "running") {
    return {
      taskId: task.id,
      roleName: role.name,
      runId: run.id,
      status: "skipped",
      reason: "not-ready"
    };
  }
  if (mode === "inject" && (
    delivery.routeProviderInput === undefined
    || delivery.canRouteProviderInput?.(run.effective.adapterId) !== true
  )) {
    return {
      taskId: task.id,
      roleName: role.name,
      runId: run.id,
      status: "skipped",
      reason: "delivery-unsupported"
    };
  }
  let deliveryAttempted = false;
  let inputDelivery: import("../coordination/workMailbox.js").InputDelivery | undefined;
  try {
    const prepared = await delivery.prepareRoleSession({
      taskId: task.id,
      roleName: role.name,
      agentId: run.effective.agentId,
      adapterId: run.effective.adapterId,
      effective: run.effective,
      workspace: run.effective.workspace.root,
      ...(run.workspace === undefined ? {} : { managedWorkspace: run.workspace }),
      mode: "resume",
      runId: run.id,
      nativeSessionId: session.nativeSessionId!
    });
    const ready = await delivery.waitUntilReady(prepared);
    const readySession = ready.session ?? session;
    if (readySession.launchId === undefined || !hasText(readySession.nativeSessionId)) {
      throw new Error("Continuation delivery has no Provider Activation fence.");
    }
    const providerFence = mode === "steer-if-safe"
      ? activeTurn!
      : {
          conversationId: readySession.nativeSessionId!,
          activationId: readySession.launchId
        };
    const claim = store.claimInputDelivery({
      target,
      attemptId: requestedBatchId,
      lane,
      mode,
      owner: "controller",
      now,
      executionRef: { type: "run", taskId: task.id, id: run.id },
      providerFence
    });
    if (claim.status === "empty") return null;
    if (claim.delivery.attemptId !== requestedBatchId || claim.status === "delivery") {
      return {
        taskId: task.id,
        roleName: role.name,
        runId: run.id,
        status: "skipped",
        reason: "delivery-uncertain"
      };
    }
    inputDelivery = claim.delivery;
    deliveryAttempted = true;
    const text = continuationInput(
      task,
      role,
      run,
      inputDelivery.attemptId,
      inputDelivery.batch,
      boundedContinuationSummaries(store, task.id, inputDelivery.batch.refs)
    );
    if (mode !== "followup") {
      const routed = await delivery.routeProviderInput!({
        delivery: ready,
        attemptId: inputDelivery.attemptId,
        mode,
        text,
        fence: providerFence
      });
      if (routed === "accepted") {
        store.completeInputDelivery(target, inputDelivery.attemptId, now);
        return { taskId: task.id, roleName: role.name, runId: run.id, status: "delivered" };
      }
      if (routed === "unknown") {
        store.markInputDeliveryUnknown(
          target,
          inputDelivery.attemptId,
          "Provider input acceptance could not be reconciled.",
          now
        );
        return {
          taskId: task.id,
          roleName: role.name,
          runId: run.id,
          status: "skipped",
          reason: "delivery-uncertain"
        };
      }
      store.releaseInputDelivery(target, inputDelivery.attemptId);
      return {
        taskId: task.id,
        roleName: role.name,
        runId: run.id,
        status: "skipped",
        reason: routed === "unavailable" ? "runtime-unavailable" : "not-ready"
      };
    }
    const outcome = await delivery.sendOnce({
      delivery: ready,
      receiptId: inputDelivery.attemptId,
      text
    });
    if (outcome === "busy" || outcome === "unavailable") {
      store.releaseInputDelivery(target, inputDelivery.attemptId);
      return {
        taskId: task.id,
        roleName: role.name,
        runId: run.id,
        status: "skipped",
        reason: outcome === "busy" ? "not-ready" : "runtime-unavailable"
      };
    }
    store.markInputDeliveryPushed(target, inputDelivery.attemptId, now);
    // Keep the exact claim until the matching provider turn.accepted Hook
    // folds it. sendOnce is receipt-idempotent, so Controller recovery cannot
    // inject a second Enter for the same batch.
    return {
      taskId: task.id,
      roleName: role.name,
      runId: run.id,
      status: outcome === "sent" ? "delivered" : "already-delivered"
    };
  } catch (error) {
    if (inputDelivery === undefined) {
      // No durable input intent existed and no provider input method was
      // called. Session preparation may be retried safely.
    } else if (!deliveryAttempted) store.releaseInputDelivery(target, inputDelivery.attemptId);
    else store.markInputDeliveryUnknown(
      target,
      inputDelivery.attemptId,
      error instanceof Error ? error.message : String(error),
      now
    );
    return {
      taskId: task.id,
      roleName: role.name,
      runId: run.id,
      status: "skipped",
      reason: deliveryAttempted ? "delivery-uncertain" : "runtime-unavailable",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function reconcileStrandedInputDelivery(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  task: SchedulerTask,
  role: SchedulerRole,
  run: SchedulerAgentRun,
  session: SchedulerRoleSession,
  input: import("../coordination/workMailbox.js").InputDelivery,
  now: Date
): Promise<ActiveRoleRunDeliveryResult> {
  const target = { kind: "role", taskId: task.id, roleName: role.name } as const;
  const uncertain = (reason: string): ActiveRoleRunDeliveryResult => {
    store.markInputDeliveryUnknown(target, input.attemptId, reason, now);
    return {
      taskId: task.id,
      roleName: role.name,
      runId: run.id,
      status: "skipped",
      reason: "delivery-uncertain"
    };
  };
  if (input.providerFence === undefined
    || delivery.reconcileProviderInput === undefined
    || delivery.canRouteProviderInput?.(run.effective.adapterId) !== true) {
    return uncertain("Controller restarted without exact Provider input readback.");
  }
  try {
    // Exact readback is addressed entirely from the durable fence. It must not
    // resume a Session, create an Activation, or call any model-starting port.
    const reconciled = await delivery.reconcileProviderInput({
      taskId: task.id,
      roleName: role.name,
      agentId: run.effective.agentId,
      adapterId: run.effective.adapterId,
      launchId: session.launchId!,
      nativeSessionId: session.nativeSessionId!,
      attemptId: input.attemptId,
      mode: input.mode,
      fence: input.providerFence
    });
    if (reconciled === "accepted") {
      store.completeInputDelivery(target, input.attemptId, now);
      return {
        taskId: task.id,
        roleName: role.name,
        runId: run.id,
        status: "already-delivered"
      };
    }
    if (reconciled === "not-accepted") {
      store.resolveInputDeliveryNotAccepted(target, input.attemptId);
      return {
        taskId: task.id,
        roleName: role.name,
        runId: run.id,
        status: "skipped",
        reason: "not-ready"
      };
    }
    return uncertain(
      reconciled === "unavailable"
        ? "Provider input readback is unavailable after Controller restart."
        : "Provider input acceptance remains unknown after metadata readback."
    );
  } catch (error) {
    return uncertain(
      `Provider input readback failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function continuationInput(
  task: SchedulerTask,
  role: SchedulerRole,
  run: SchedulerAgentRun,
  attemptId: string,
  batch: Readonly<{
    reasons: readonly string[];
    refs: readonly import("../coordination/workMailbox.js").MailboxEntityRef[];
    sources: readonly string[];
  }>,
  resultSummaries: readonly string[]
): string {
  const references = batch.refs.map((ref) => (
    "taskId" in ref
      ? `${ref.type}:${ref.taskId}/${ref.id}`
      : `${ref.type}:${ref.id}`
  ));
  return markYuiRunInput([
    `Yui Task Event Batch: ${attemptId}.`,
    "New durable task events are available for the current Yui Run.",
    "Read the referenced shared context through the Yui CLI, incorporate it, and decide whether to continue work or wait for more results.",
    "Do not create a new Yui Run merely because this is a new Provider Turn.",
    `Reasons: ${batch.reasons.join(", ")}.`,
    ...(batch.sources.length === 0 ? [] : [`Sources: ${batch.sources.join(", ")}.`]),
    ...(references.length === 0 ? [] : [`References: ${references.join(", ")}.`]),
    ...(resultSummaries.length === 0
      ? []
      : [
          "Native child results (bounded excerpts; read the referenced event for the full content):",
          ...resultSummaries
        ])
  ].join("\n"), run.id, taskRoleSessionTitle(task, role.name));
}

/**
 * Issue 13: the parent prompt only ever sees a bounded excerpt of a native
 * child result plus its durable event reference. The full content stays in
 * the Task event log and is read on demand through `yui task event show`.
 * This prevents an unbounded provider result from being re-injected into the
 * parent Session on every continuation wake.
 */
const MAX_RESULT_SUMMARY_CHARS = 512;
const MAX_RESULT_SUMMARY_LINES = 8;

function boundedContinuationSummaries(
  store: SchedulerStorePort,
  taskId: string,
  refs: readonly import("../coordination/workMailbox.js").MailboxEntityRef[]
): readonly string[] {
  if (store.listEvents === undefined) return [];
  const events = store.listEvents(taskId);
  const continuations = projectProviderContinuations(events);
  const byKey = new Map(continuations.map((entry) => [
    `${entry.identity.continuationId}\u0000${entry.identity.generation}`,
    entry
  ]));
  const summaries: string[] = [];
  for (const ref of refs) {
    if (!("taskId" in ref) || ref.type !== "event") continue;
    const event = events.find((entry) => entry.id === ref.id);
    if (event === undefined) continue;
    const observation = runtimeObservationFromTaskEvent(event);
    if (observation === null || observation.kind !== "continuation.reported") continue;
    const summary = observation.payload?.summary;
    if (summary === undefined || summary.trim().length === 0) continue;
    const continuation = byKey.get(
      `${observation.fence.continuationId}\u0000${observation.fence.continuationGeneration}`
    );
    const digest = continuation?.reports
      .find((report) => report.reportId === observation.payload?.reportId)
      ?.resultDigest;
    summaries.push([
      `- child ${observation.fence.continuationId}`,
      ...(continuation?.durability === "durable-result"
        ? ["  (durable-result; full content: "
          + `yui task event show ${taskId} ${ref.id}`
          + (digest === undefined ? "" : `; digest ${digest.slice(0, 12)}`)
          + ")"]
        : ["  (best-effort; rerun if the parent Session was lost)"]),
      `  ${boundedExcerpt(summary)}`
    ].join("\n"));
  }
  return summaries;
}

function boundedExcerpt(text: string): string {
  const lines = text.split("\n").slice(0, MAX_RESULT_SUMMARY_LINES);
  const joined = lines.join("\n");
  if (joined.length <= MAX_RESULT_SUMMARY_CHARS && text.length === joined.length) return joined;
  return `${joined.slice(0, MAX_RESULT_SUMMARY_CHARS)}… [truncated]`;
}

function roleRunDeliveryFailure(
  run: SchedulerAgentRun,
  mailboxBatchId: string,
  session: SchedulerRoleSession | null,
  launchId: string | undefined
): Omit<RoleRunDeliveryFailurePersistence, "now"> {
  return {
    taskId: run.taskId,
    roleName: run.roleName,
    agentId: run.effective.agentId,
    adapterId: run.effective.adapterId,
    runId: run.id,
    mailboxBatchId,
    ...(session?.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: session.nativeSessionId }),
    ...(launchId === undefined ? {} : { launchId })
  };
}

function requireResumeSession(
  role: SchedulerRole,
  effective: import("../executor/effectiveLaunch.js").EffectiveLaunchSnapshot,
  session: SchedulerRoleSession | null
): string {
  if (session === null || !hasText(session.nativeSessionId)) {
    throw new Error(`Role resume has no fixed native session: ${role.taskId}/${role.name}.`);
  }
  if (!effectiveLaunchSnapshotsCompatibleForTaskMain(
    session.effective,
    effective,
    role.managedWorkspace
  )) {
    throw new Error(`Role resume effective snapshot drifted: ${role.taskId}/${role.name}.`);
  }
  return session.nativeSessionId;
}

function persistPreStartFence(
  store: SchedulerStorePort,
  task: SchedulerTask,
  role: SchedulerRole,
  run: SchedulerAgentRun,
  existingSession: SchedulerRoleSession | null,
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
    throw new Error(`Pre-start launch fence changed the active Role Run: ${task.id}/${role.name}.`);
  }
  const session = preflightSession(
    role,
    run.effective,
    existingSession,
    run.mode,
    preflight
  );
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
  return validateRoleSession(role, effective, existing, mode, session);
}

/**
 * A Controller restart can recover an exact launch-submitted Run while its
 * finite provider process is still alive. The host intentionally does not
 * re-plan or re-submit that Run and therefore may return no native identity;
 * retain only the durable Session fenced to the same launch generation.
 */
function validateLaunchSubmittedRecoverySession(
  role: SchedulerRole,
  effective: import("../executor/effectiveLaunch.js").EffectiveLaunchSnapshot,
  existing: SchedulerRoleSession | null,
  mode: "new" | "resume",
  prepared: PreparedRoleDelivery,
  session: SchedulerRoleSession | null | undefined
): SchedulerRoleSession | null {
  if (
    session === null
    && prepared.inputSubmittedAtLaunch === true
    && prepared.sessionStarted === false
    && existing?.launchId !== undefined
    && existing.launchId === prepared.launchId
  ) {
    return validateRoleSession(role, effective, existing, mode, existing);
  }
  return session === undefined
    ? existing
    : validateRoleSession(role, effective, existing, mode, session);
}

function validateRoleSession(
  role: SchedulerRole,
  effective: import("../executor/effectiveLaunch.js").EffectiveLaunchSnapshot,
  existing: SchedulerRoleSession | null,
  mode: "new" | "resume",
  session: SchedulerRoleSession | null
): SchedulerRoleSession | null {
  if (mode === "new" && session === null) return null;
  if (session === null || !hasText(session.nativeSessionId)) {
    throw new Error(`Ready Role session has no native session id: ${role.taskId}/${role.name}.`);
  }
  if (session.agentId !== effective.agentId || session.adapterId !== effective.adapterId) {
    throw new Error(`Ready Role session identity changed: ${role.taskId}/${role.name}.`);
  }
  const compatible = mode === "resume"
    ? effectiveLaunchSnapshotsCompatibleForTaskMain(
        session.effective,
        effective,
        role.managedWorkspace
      )
    : effectiveLaunchSnapshotsCompatible(session.effective, effective);
  if (!compatible) {
    throw new Error(`Ready Role session effective snapshot changed: ${role.taskId}/${role.name}.`);
  }
  if (existing?.nativeSessionId !== undefined
    && effectiveLaunchSnapshotsCompatibleForTaskMain(
      existing.effective,
      effective,
      role.managedWorkspace
    )
    && session.nativeSessionId !== existing.nativeSessionId) {
    throw new Error(`Ready Role session changed the fixed native session id: ${role.taskId}/${role.name}.`);
  }
  if (mode === "resume" && session.nativeSessionId !== existing?.nativeSessionId) {
    throw new Error(`Role resume changed the fixed native session id: ${role.taskId}/${role.name}.`);
  }
  return {
    ...session,
    status: "running",
    ...(mode === "resume" && existing !== null
      ? { effective: existing.effective }
      : {})
  };
}

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Fail-closed readiness check for a supported-readiness adapter's first push.
 * When the store cannot answer (no implementation), the push is held rather than
 * proceeding blind — a supported adapter must have a proven provider-ready fold.
 */
function providerReadyForPush(
  store: SchedulerStorePort,
  input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    launchId?: string;
    nativeSessionId?: string;
  }>
): boolean {
  if (store.isRoleGenerationProviderReady === undefined) return false;
  return store.isRoleGenerationProviderReady(input);
}
