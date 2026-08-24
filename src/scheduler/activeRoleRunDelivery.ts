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
import { prefixYuiTitleInput } from "../run/runIdentity.js";
import { resolveTaskRoleSessionTitle } from "../runtime/sessionTitle.js";
import { agentRunDeliveryReceiptId } from "../run/agentRun.js";
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
import { serializeRunBootstrapEnvelope } from "../context/runContextContract.js";
import { serializeProviderRetryEnvelope } from "../run/providerRetry.js";
import { serializeWorkflowOutcomeRequestEnvelope } from "../run/runControlRequest.js";

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
      if (run !== null && run.pushedAt !== undefined
        && run.providerRetry?.state !== "dispatching"
        && run.controlRequest?.state !== "dispatching") {
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
      if (run === null
        || (run.pushedAt !== undefined
          && run.providerRetry?.state !== "dispatching"
          && run.controlRequest?.state !== "dispatching")) continue;
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
      const receiptId = agentRunDeliveryReceiptId(run);
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
      let providerSubmissionBegun = false;
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
        // A managed Host may have submitted the exact Run Turn after its
        // two-phase launch handshake. Once preparation returns that transport
        // fact, any
        // later readiness or aggregate-write failure is delivery uncertainty,
        // not a launch failure: preserve the Run and its reservation for the
        // matching provider Hook instead of terminalizing it.
        deliveryAttempted = prepared.turnAcceptedDuringLaunch === true
          || prepared.turnDeliveryUnknownDuringLaunch === true;
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
          || ready.prepared.turnAcceptedDuringLaunch === true
          || ready.prepared.turnDeliveryUnknownDuringLaunch === true;
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
        if (ready.prepared.turnRejectedDuringLaunch === true) {
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
            status: "skipped",
            reason: "not-ready"
          });
          continue;
        }
        if (ready.prepared.turnDeliveryUnknownDuringLaunch === true) {
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
            status: "skipped",
            reason: "delivery-uncertain"
          });
          continue;
        }
        if (ready.prepared.turnAcceptedDuringLaunch === true) {
          // The newly-created Agent Host already submitted the exact Run Turn
          // through Provider-native control. Persist launch transport success;
          // only the matching structured acknowledgement marks it accepted.
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
        if (session === null || session.launchId === undefined
          || !hasText(session.nativeSessionId)
          || store.beginRoleRunProviderTurn?.({
            taskId: task.id,
            roleName: role.name,
            runId: run.id,
            agentId: run.effective.agentId,
            launchId: session.launchId,
            nativeSessionId: session.nativeSessionId,
            attemptId: receiptId,
            now
          }) !== true) {
          throw new Error("Provider Turn intent could not be durably fenced before delivery.");
        }
        providerSubmissionBegun = true;
        deliveryAttempted = true;
        const launchText = run.controlRequest?.state === "dispatching"
          ? serializeWorkflowOutcomeRequestEnvelope({
              taskId: task.id,
              runId: run.id,
              roleName: role.name,
              request: run.controlRequest
            })
          : run.providerRetry?.state === "dispatching"
            ? serializeProviderRetryEnvelope({
                taskId: task.id,
                runId: run.id,
                roleName: role.name,
                retry: run.providerRetry
              })
            : serializeRunBootstrapEnvelope(run.bootstrapEnvelope);
        const outcome = await delivery.sendOnce({
          delivery: ready,
          receiptId,
          text: prefixYuiTitleInput(
            launchText,
            resolveTaskRoleSessionTitle(session.title, task, role.name)
          )
        });
        if (outcome === "busy" || outcome === "unavailable") {
          store.resolveRoleRunProviderSubmission?.({
            taskId: task.id,
            roleName: role.name,
            runId: run.id,
            attemptId: receiptId,
            status: "rejected",
            reason: outcome === "busy"
              ? "Agent Host was busy before Provider mutation."
              : "Agent Host was unavailable before Provider mutation.",
            now
          });
          providerSubmissionBegun = false;
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
        if (outcome === "rejected") {
          store.resolveRoleRunProviderSubmission?.({
            taskId: task.id,
            roleName: role.name,
            runId: run.id,
            attemptId: receiptId,
            status: "rejected",
            reason: "Provider returned an exact negative acknowledgement.",
            now
          });
          providerSubmissionBegun = false;
          results.push({
            taskId: task.id,
            roleName: role.name,
            runId: run.id,
            status: "skipped",
            reason: "not-ready"
          });
          continue;
        }
        if (outcome === "delivery-unknown") {
          store.resolveRoleRunProviderSubmission?.({
            taskId: task.id,
            roleName: role.name,
            runId: run.id,
            attemptId: receiptId,
            status: "delivery-unknown",
            reason: "Provider Turn delivery is ambiguous; automatic retry is fenced.",
            now
          });
          providerSubmissionBegun = false;
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
          results.push({
            taskId: task.id,
            roleName: role.name,
            runId: run.id,
            status: "skipped",
            reason: "delivery-uncertain"
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
        if (providerSubmissionBegun) {
          store.resolveRoleRunProviderSubmission?.({
            taskId: task.id,
            roleName: role.name,
            runId: run.id,
            attemptId: receiptId,
            status: "delivery-unknown",
            reason: message,
            now
          });
        }
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
  const writer = store.getProviderAuthorityFence?.({
    taskId: task.id,
    roleName: role.name,
    runId: run.id,
    agentId: run.effective.agentId,
    launchId: session.launchId,
    nativeSessionId: session.nativeSessionId
  }) ?? null;
  if (writer !== null && writer.owner !== "controller") {
    return {
      taskId: task.id,
      roleName: role.name,
      runId: run.id,
      status: "skipped",
      reason: "writer-attached"
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
        task,
        role,
        run,
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
  // Managed input has one write path: a new structured Turn at a settled
  // boundary. Corrections retain their priority while the current Turn runs.
  const mode = "followup" as const;
  if (session.status === "running") {
    return {
      taskId: task.id,
      roleName: role.name,
      runId: run.id,
      status: "skipped",
      reason: "not-ready"
    };
  }
  if (writer === null) {
    return {
      taskId: task.id,
      roleName: role.name,
      runId: run.id,
      status: "skipped",
      reason: "not-ready"
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
    const providerFence = {
      conversationId: writer.conversationId,
      activationId: writer.activationId
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
    const outcome = await delivery.sendOnce({
      delivery: ready,
      receiptId: inputDelivery.attemptId,
      text
    });
    if (outcome === "busy" || outcome === "unavailable") {
      store.releaseInputDelivery(target, inputDelivery.attemptId, now);
      return {
        taskId: task.id,
        roleName: role.name,
        runId: run.id,
        status: "skipped",
        reason: outcome === "busy" ? "not-ready" : "runtime-unavailable"
      };
    }
    if (outcome === "rejected") {
      store.resolveInputDeliveryNotAccepted(target, inputDelivery.attemptId, now);
      return {
        taskId: task.id,
        roleName: role.name,
        runId: run.id,
        status: "skipped",
        reason: "not-ready"
      };
    }
    if (outcome === "delivery-unknown") {
      store.markInputDeliveryUnknown(
        target,
        inputDelivery.attemptId,
        "Provider Turn delivery is ambiguous; automatic retry is fenced.",
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
    store.markInputDeliveryPushed(target, inputDelivery.attemptId, now);
    // Keep the exact claim until the matching provider turn.accepted Hook
    // folds it. An interrupted acknowledgement becomes delivery-unknown and
    // cannot be resubmitted automatically.
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
    } else if (!deliveryAttempted) store.releaseInputDelivery(target, inputDelivery.attemptId, now);
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
  task: SchedulerTask,
  role: SchedulerRole,
  run: SchedulerAgentRun,
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
  return uncertain(
    "Controller restarted with unsettled Provider delivery; automatic resubmission is fenced."
  );
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
  return [
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
  ].join("\n");
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
        ...(preflight.sessionTitle === undefined ? {} : { title: preflight.sessionTitle }),
        status: "ready" as const,
        effective: preflight.effective
      };
  return validateRoleSession(role, effective, existing, mode, session);
}

/**
 * A Controller restart can recover an exact launch-submitted Run while its
 * persistent Provider process is still alive. The Host intentionally does not
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
    && (prepared.turnAcceptedDuringLaunch === true
      || prepared.turnDeliveryUnknownDuringLaunch === true
      || prepared.turnRejectedDuringLaunch === true)
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
