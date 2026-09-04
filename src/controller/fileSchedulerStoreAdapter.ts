import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { DurableJob } from "../job/durableJob.js";
import type { MailboxEntityRef } from "../coordination/workMailbox.js";
import {
  type SchedulerTelemetry,
  type TelemetryProgressEntry
} from "../telemetry/telemetryStore.js";

import {
  activeLiveRoleAgentSession,
  bindTaskRoleProviderRuntime,
  createRoleSessionSet,
  recordRoleAgentSession,
  replaceTaskRoleAgentSession,
  recordTaskRoleTurnBoundary,
  rememberRoleAgentCompletedTurn,
  detachRoleAgentSessionHost,
  updateRoleAgentSessionStatus,
  updateTaskRoleProviderRuntime,
  type AgentSessionStatus,
  type GlobalRoleSessionSet,
  type RoleAgentSession,
  type TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import {
  acceptProviderTurn,
  beginProviderTurn,
  createProviderRuntimeBinding,
  endProviderActivation,
  currentProviderActivation,
  currentProviderConversation,
  managedProviderTurnId,
  clearProviderGoal,
  providerGoalContinues,
  settleProviderTurnSubmission,
  settleProviderTurn,
  startProviderActivation,
  supersedeProviderConversation,
  updateProviderConversationRecoverability,
  updateProviderGoal
} from "../runtime/providerRuntimeIdentity.js";
import {
  hasRecentTurnId
} from "../runtime/recentTurnIds.js";
import { createTaskEvent, type TaskEvent } from "../event/taskEvent.js";
import { operationalTaskRecords } from "../task/taskRecordRetirement.js";
import {
  buildTaskWakeEnvelope,
  type WakeEnvelope
} from "../context/wakeNotification.js";
import { createTaskWake, fallbackWakeCursor, latestTaskWake } from "../scheduler/taskWake.js";
import { answerInputRequest } from "../input/inputRequest.js";
import { activeRoleAgentBinding } from "../role/role.js";
import {
  effectiveLaunchWithTaskMainWorkspace,
  effectiveLaunchSnapshotsCompatible,
  effectiveLaunchSnapshotsCompatibleForTaskSession,
  resolveEffectiveLaunch,
  validateEffectiveLaunchSnapshot,
  type EffectiveLaunchSnapshot
} from "../executor/effectiveLaunch.js";
import { SYSTEM_OPERATOR_ROLE } from "../role/systemRoles.js";
import {
  appendTurnInput,
  createTurn,
  type Turn
} from "../turn/turn.js";
import { transportAgentResult } from "../domain/agentResultTransport.js";
import { createTurnInput } from "../context/turnInputContract.js";
import {
  classifyRuntimeProcessExit,
  validateRuntimeProcessExitObservation
} from "../runtime/processExitObservation.js";
import { terminalizeExactTaskTurn } from "../lifecycle/exactTurnTerminalization.js";
import {
  createCanonicalLifecycleEvent,
  foldCanonicalLifecycleEvent,
  type CanonicalIdentityFence,
  type CanonicalTurnExpectation
} from "../lifecycle/canonicalLifecycleEvent.js";
import type {
  ProviderLifecycleObservation,
} from "./runtimeEventProcessor.js";
import type {
  DormantRuntimeOwnerCandidate,
  LeaderDispatchClaimResult,
  LeaderDispatchPersistence,
  LeaderSteerPersistence,
  RoleTurnDeliveryFailurePersistence,
  RoleTurnDeliveryPersistence,
  RoleTurnDiagnosticPersistence,
  RoleTurnProgressPersistence,
  RoleTurnStallPersistence,
  SchedulerTurnProgress,
  SchedulerRole,
  SchedulerRoleSession,
  SchedulerStorePort,
  TurnProgressFacts,
} from "../scheduler/ports.js";
import { recordLeaderFailure } from "../scheduler/leaderFailure.js";
import {
  enqueueOperatorEvent,
  recordLeaderAttentionRequired,
  routeRoleEvent
} from "../scheduler/operatorEvent.js";
import { pendingWakeupsMatch } from "../scheduler/pendingWakeup.js";
import { queueLeaderWakeup } from "../scheduler/wakeupQueue.js";
import { wakeReason } from "../scheduler/wakeReason.js";
import {
  foldTurnProgressFacts,
  latestTurnDurableProgressAt,
  latestTurnEventTime,
  latestStallEvidenceKey,
  isRoleTurnStalled,
  TURN_PROGRESS_EVENT,
  TURN_DIAGNOSTIC_FINISHED_EVENT,
  TURN_RECOVERED_EVENT,
  TURN_STALLED_EVENT
} from "../scheduler/roleTurnStall.js";
import { pendingWakeupProjection, type TaskStore } from "../storage/taskStore.js";
import type {
  RuntimeSessionCandidate,
  RuntimeSessionCandidateQuery
} from "../runtime/runtimeSessionCandidate.js";
import { projectProviderContinuations } from "../runtime/runtimeContinuationProjection.js";
import { providerContinuationKey } from "../runtime/providerContinuation.js";
import {
  formatTurnReceiptId,
  formatTaskRecordReference
} from "../task/taskRecordReference.js";
import {
  bindExecution,
  claimPending,
  completeProcessing,
  consumePendingBatch,
  mailboxHasPending,
  mailboxHasWork,
  releaseProcessing,
  type MailboxTarget,
  type WorkMailbox
} from "../coordination/workMailbox.js";
import {
  enqueueWork,
  settleRoleTurnDispatch as settleRoleTurnDispatchMailbox
} from "../coordination/workMailboxQueue.js";
import type { SchedulerMailboxClaimInput, SchedulerMailboxClaimResult } from "../scheduler/ports.js";
import {
  RUNTIME_CLEANUP_REQUIRED_REASON,
  RUNTIME_HOST_DETACH_REQUIRED_REASON,
  RUNTIME_LAUNCH_RESERVED_REASON,
  RUNTIME_LIFECYCLE_OWNER,
  RuntimeLifecycleBusyError,
  hasRuntimeCleanupObligation,
  hasRuntimeLifecycleWork,
  isRuntimeCleanupReason,
  isRuntimeLaunchReservation,
  runtimeCleanupDisposition,
  runtimeLifecycleTarget,
  type RuntimeLifecycleTarget,
  type RuntimeRoleOwner
} from "../runtime/lifecycleReservation.js";
import { nativeSessionIdForLaunch } from "../runtime/preallocatedNativeSession.js";
import {
  builtinAgentDriverRegistry
} from "../runtime/builtinAgentDrivers.js";
import type { AgentDriverRegistry } from "../runtime/agentDriver.js";
import { standardAgentError } from "../runtime/agentError.js";
import {
  RUNTIME_OBSERVATION_TASK_EVENT,
  createRuntimeObservation,
  isRuntimeTokenEvidence,
  runtimeObservationFenceMatches,
  runtimeObservationFromTaskEvent,
  runtimeObservationTurnFenceMatches,
  runtimeObservationTaskEventPayload,
  type RuntimeObservation
} from "../runtime/runtimeObservation.js";
import { projectRuntimeTaskEvents } from "../runtime/runtimeProjection.js";
import { contextSnapshotRef } from "../context/contextSnapshot.js";
import { snapshotExecutionLaneWorkspaceSync } from "../repository/executionLaneGitSnapshot.js";
import {
  contextSnapshotDeltaRefIds,
  freezeTurnContextSnapshot
} from "../context/turnContextPack.js";
import type { RuntimeTurnTerminalOutcome } from "./runtimeEventInbox.js";

/**
 * One durable revision's read-only facts for one Task. A scheduler pass reads
 * the same revision's large event history once per Task and folds the per-Turn
 * progress facts in a single O(events) pass; every per-Role/per-phase query is
 * then served from this bounded projection instead of re-cloning and
 * re-scanning the whole history per candidate. The projection is rebuilt as
 * soon as the durable revision advances (own commit or external writer), so it
 * is never dispatch/claim/complete authority: every mutation re-reads the
 * exact records under the storage lock/CAS.
 *
 * All seven record families the actionability digest folds (turns,
 * workItems, reviewRounds, integrationAttempts, inputRequests, durableJobs,
 * messages) are read in the same projection build, so a single digest
 * computation sees a consistent per-revision snapshot even under concurrent
 * writers (Issue 05).
 */
type TaskReadProjection = Readonly<{
  events: readonly TaskEvent[];
  turnFacts: ReadonlyMap<string, TurnProgressFacts>;
  turns: ReturnType<TaskStore["listTurns"]>;
  workItems: ReturnType<TaskStore["listWorkItems"]>;
  reviewRounds: ReturnType<TaskStore["listReviewRounds"]>;
  changeSets: ReturnType<TaskStore["listChangeSets"]>;
  integrationAttempts: ReturnType<TaskStore["listIntegrationAttempts"]>;
  inputRequests: ReturnType<TaskStore["listInputRequests"]>;
  durableJobs: ReturnType<TaskStore["listDurableJobs"]>;
  messages: ReturnType<TaskStore["listMessages"]>;
}>;

export class AgentHostProviderTurnFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentHostProviderTurnFenceError";
  }
}

/** Maps authoritative TaskStore records to the scheduler's narrow port. */
export class FileSchedulerStoreAdapter implements SchedulerStorePort {
  /** Diagnostic telemetry is optional and never participates in runtime truth. */
  constructor(
    readonly store: TaskStore,
    private readonly telemetry: SchedulerTelemetry | null = null,
    private readonly drivers: AgentDriverRegistry = builtinAgentDriverRegistry(),
    private readonly snapshotExecutionLaneWorkspace = snapshotExecutionLaneWorkspaceSync
  ) {}

  freezeLeaderContextSnapshot(taskId: string, roleName: string, now: Date) {
    return this.store.transaction((tx) => {
      const snapshot = freezeTurnContextSnapshot(tx, {
        taskId,
        roleName,
        purpose: "execution"
      }, now);
      return Object.freeze({
        ref: contextSnapshotRef(snapshot),
        deltaRefIds: contextSnapshotDeltaRefIds(tx, snapshot)
      });
    });
  }

  /**
   * Sole provider-independent ingress for structured runtime state. Driver
   * mapping has already happened before this boundary; this method validates
   * the exact durable Turn/session fence, applies the small workflow-relevant
   * transitions, and retains the canonical observation for status projection.
   */
  observeRuntimeObservation(
    raw: RuntimeObservation,
    now = new Date()
  ): ProviderLifecycleObservation {
    const input = createRuntimeObservation(raw);
    const taskId = input.fence.taskId;
    if (taskId === undefined) return "obsolete";
    if (Date.parse(input.receivedAt) > now.getTime()) {
      return this.recordObsoleteCanonicalObservation(input, "received-at-in-future", now);
    }
    const adapterId = this.adapterForRuntimeObservation(input);
    if (adapterId === null) {
      return this.recordObsoleteCanonicalObservation(input, "driver-or-turn-mismatch", now);
    }
    if (hasPersistedRuntimeObservation(this.store.listEvents(taskId), input)) return "applied";
    let outcome: ProviderLifecycleObservation;
    switch (input.kind) {
      case "session.started":
      case "session.ready":
        outcome = this.observeRuntimeSession(input, adapterId, now);
        break;
      case "turn.accepted":
      case "input.accepted":
        outcome = this.observeRuntimePromptAccepted(input, adapterId, now);
        break;
      case "turn.completed":
        outcome = this.foldProviderTurnBoundary(
          input,
          adapterId,
          "completed",
          now
        );
        break;
      case "turn.failed": {
        // A Provider Turn is an activation boundary, not a Task outcome.
        // Keep the Turn and Session identity available for Agent-directed
        // restore + submit, even when a provider marks its Turn terminal.
        outcome = this.foldProviderTurnBoundary(
          input,
          adapterId,
          "failed",
          now
        );
        break;
      }
      case "operation.started":
      case "operation.completed":
      case "operation.failed":
      case "turn.waiting":
      case "activity.observed":
      case "observer.health":
      case "native-work.snapshot":
      case "continuation.started":
      case "continuation.reported":
      case "continuation.settled":
      case "input.delivery-unknown":
        outcome = this.validateCanonicalTurnObservation(input, now);
        break;
      case "turn.cancelled": {
        outcome = this.foldProviderTurnBoundary(
          input,
          adapterId,
          "cancelled",
          now
        );
        break;
      }
      case "conversation.observed":
      case "activation.started":
      case "activation.ended":
      case "activation.failed":
        outcome = this.observeProviderRuntimeIdentity(input, now);
        break;
      case "goal.updated":
      case "goal.cleared":
        outcome = this.observeProviderGoal(input, now);
        break;
      case "session.ended":
      case "session.failed":
        outcome = this.validateCanonicalSessionObservation(input, now);
        break;
      case "host.observed":
        outcome = "obsolete";
        break;
      default:
        outcome = "obsolete";
    }
    if (outcome === "applied") this.persistRuntimeObservation(input, now);
    return outcome;
  }

  private adapterForRuntimeObservation(
    input: RuntimeObservation
  ): string | null {
    const taskId = input.fence.taskId;
    const turnId = input.fence.turnId;
    if (taskId === undefined) return null;
    if (turnId === undefined) {
      const role = this.store.getRole(taskId, input.fence.roleName);
      const sessions = this.store.getTaskRoleSessionSet(taskId, input.fence.roleName);
      const session = sessions?.sessions[input.fence.agentId];
      if (role?.activeAgentId !== input.fence.agentId
        || session?.adapterId === undefined) return null;
      try {
        return this.drivers.requireByAdapterId(session.adapterId).id === input.fence.driverId
          ? session.adapterId
          : null;
      } catch {
        return null;
      }
    }
    const run = this.store.getTurn(taskId, turnId);
    if (run === null
      || run.roleName !== input.fence.roleName
      || run.effective.agentId !== input.fence.agentId) return null;
    try {
      return this.drivers.requireByAdapterId(run.effective.adapterId).id === input.fence.driverId
        ? run.effective.adapterId
        : null;
    } catch {
      return null;
    }
  }

  private validateCanonicalTurnObservation(
    input: RuntimeObservation,
    now: Date
  ): ProviderLifecycleObservation {
    return this.store.transaction((store) => {
      if (hasPersistedRuntimeObservation(store.listEvents(input.fence.taskId!), input)) {
        return "applied";
      }
      const run = store.getTurn(input.fence.taskId!, input.fence.turnId!);
      const active = store.getActiveTurn(input.fence.taskId!, input.fence.roleName);
      const sessions = store.getTaskRoleSessionSet(input.fence.taskId!, input.fence.roleName);
      const session = sessions?.sessions[input.fence.agentId];
      const knownContinuation = input.kind.startsWith("continuation.")
        && projectProviderContinuations(store.listEvents(input.fence.taskId!)).some((entry) => (
          entry.turnId === input.fence.turnId
          && entry.identity.providerNamespace === input.fence.driverId
          && entry.identity.accountScope === input.fence.agentId
          && entry.identity.conversationId === input.fence.conversationId
          && entry.identity.activationId === input.fence.activationId
          && entry.identity.continuationId === input.fence.continuationId
          && entry.identity.generation === input.fence.continuationGeneration
        ));
      const requiresCurrentRuntime = input.kind !== "turn.cancelled" && !knownContinuation;
      const valid = run !== null
        && (!requiresCurrentRuntime || (run.status === "active" && active?.id === run.id))
        && run.roleName === input.fence.roleName
        && run.effective.agentId === input.fence.agentId
        && this.drivers.requireByAdapterId(run.effective.adapterId).id === input.fence.driverId
        && (knownContinuation || (
          session?.runtimeGenerationId === input.fence.runtimeGenerationId
          && session.nativeSessionId === input.fence.nativeSessionId
        ))
        && runtimeReceiptBelongsToTurn(store, input);
      if (!valid) {
        recordCanonicalObservationObsolete(store, input, "runtime-fence-not-current", now);
        return "obsolete";
      }
      return "applied";
    });
  }

  private foldProviderTurnBoundary(
    input: RuntimeObservation,
    adapterId: string,
    providerStatus: "completed" | "failed" | "cancelled",
    now: Date
  ): ProviderLifecycleObservation {
    const outcome = providerStatus === "completed"
      ? transportAgentResult(input.payload.output)
      : {
          status: "failed" as const,
          diagnostic: providerStatus === "cancelled"
            ? "Provider cancelled the Agent Turn."
            : `Provider Agent Turn failed: ${input.payload.failure?.error.message ?? "unknown provider failure"}`,
          failureReason: providerStatus === "cancelled"
            ? "cancelled" as const
            : "runtime-failed" as const
        };
    const completed = {
      taskId: input.fence.taskId!,
      roleName: input.fence.roleName,
      agentId: input.fence.agentId,
      adapterId,
      runtimeGenerationId: input.fence.runtimeGenerationId,
      nativeSessionId: input.fence.nativeSessionId!,
      nativeTurnId: input.fence.nativeTurnId!,
      attemptId: input.fence.receiptId,
      turnId: input.fence.turnId,
      ...(input.payload.input === undefined ? {} : { input: input.payload.input }),
      providerStatus,
      outcome
    };
    const classification = this.classifyRuntimeTurnTerminal(completed);
    if (classification !== "apply") return classification;
    const result = this.observeRuntimeTurnTerminal(completed, now);
    return result.disposition === "obsolete" ? "obsolete" : "applied";
  }

  private validateCanonicalSessionObservation(
    input: RuntimeObservation,
    now: Date
  ): ProviderLifecycleObservation {
    return this.store.transaction((store) => {
      const run = store.getTurn(input.fence.taskId!, input.fence.turnId!);
      const sessions = store.getTaskRoleSessionSet(input.fence.taskId!, input.fence.roleName);
      const session = sessions?.sessions[input.fence.agentId];
      if (run === null
        || run.roleName !== input.fence.roleName
        || run.effective.agentId !== input.fence.agentId
        || this.drivers.requireByAdapterId(run.effective.adapterId).id !== input.fence.driverId
        || session?.runtimeGenerationId !== input.fence.runtimeGenerationId
        || session.nativeSessionId !== input.fence.nativeSessionId) {
        recordCanonicalObservationObsolete(store, input, "runtime-session-not-current", now);
        return "obsolete";
      }
      const status: AgentSessionStatus = "ended";
      let updatedSessions = updateRoleAgentSessionStatus(
        sessions!,
        input.fence.agentId,
        status,
        now,
        input.kind === "session.failed" ? "failed" : "stopped"
      );
      if (updatedSessions.providerBinding !== null) {
        const activationId = input.fence.activationId ?? input.fence.runtimeGenerationId;
        updatedSessions = updateTaskRoleProviderRuntime(
          updatedSessions,
          endProviderActivation(updatedSessions.providerBinding, activationId, {
            status: input.kind === "session.failed" ? "failed" : "ended",
            endedAt: input.observedAt ?? input.receivedAt,
            reason: input.kind
          }),
          now
        );
      }
      store.saveTaskRoleSessionSet(updatedSessions);
      for (const continuation of projectProviderContinuations(
        store.listEvents(input.fence.taskId!)
      )) {
        if (continuation.turnId !== input.fence.turnId
          || continuation.identity.conversationId
            !== (input.fence.conversationId ?? input.fence.nativeSessionId)
          || continuation.identity.activationId
            !== (input.fence.activationId ?? input.fence.runtimeGenerationId)
          || continuation.execution === "quiescent"
          || continuation.attachment === "detached") continue;
        const key = providerContinuationKey(continuation.identity);
        const identityDigest = createHash("sha256").update(key).digest("hex");
        const detached = createRuntimeObservation({
          schemaVersion: 4,
          eventId: `derived-continuation-detached:${identityDigest}`,
          semanticKey: `continuation-detached:${identityDigest}`,
          kind: "continuation.started",
          authority: "controller",
          receivedAt: input.receivedAt,
          observedAt: input.observedAt ?? input.receivedAt,
          fence: {
            ...input.fence,
            conversationId: continuation.identity.conversationId,
            activationId: continuation.identity.activationId,
            continuationId: continuation.identity.continuationId,
            continuationGeneration: continuation.identity.generation,
            ...(continuation.parentContinuationId === undefined
              ? {}
              : { parentContinuationId: continuation.parentContinuationId })
          },
          payload: {
            execution: continuation.execution,
            outcome: continuation.outcome,
            attachment: "detached",
            observationQuality: continuation.observation,
            mayWriteWorkspace: continuation.mayWriteWorkspace,
            ...(continuation.resultRef === undefined
              ? {}
              : { resultRef: continuation.resultRef })
          }
        });
        const eventId = store.nextEventId(input.fence.taskId!);
        const detachedEvent = createTaskEvent(
          eventId,
          input.fence.taskId!,
          RUNTIME_OBSERVATION_TASK_EVENT,
          runtimeObservationTaskEventPayload(detached),
          now
        );
        store.saveEvent(input.fence.taskId!, detachedEvent);
        routeContinuationResult(
          store,
          detached,
          detachedEvent,
          "provider-continuation-detached",
          now
        );
      }
      const active = store.getActiveTurn(input.fence.taskId!, input.fence.roleName);
      const role = store.getRole(input.fence.taskId!, input.fence.roleName);
      if ((input.kind === "session.ended" || input.kind === "session.failed")
        && active !== null
        && active.id === input.fence.turnId
        && active.status === "active"
        && role !== null) {
        if (role.name === "leader") {
          const message = [
            `Leader native Session became unavailable while Turn ${active.id} remains active.`,
            "Yui preserved the Turn because Session/host termination is not a Task outcome.",
            "Retire the disposable Turn, or use Task execution stop/start if the current runtime cannot be settled normally."
          ].join(" ");
          recordLeaderAttentionRequired(store, {
            taskId: input.fence.taskId!,
            reason: "leader-runtime-detached",
            payload: { message, turnId: active.id },
            now
          });
        } else {
          enqueueWork(store, {
            kind: "role",
            taskId: input.fence.taskId!,
            roleName: "leader"
          }, "role-runtime-detached", now, [
            { type: "turn", taskId: input.fence.taskId!, id: active.id }
          ]);
        }
      }
      return "applied";
    });
  }

  private persistRuntimeObservation(input: RuntimeObservation, now: Date): void {
    this.store.transaction((store) => {
      const taskId = input.fence.taskId!;
      const events = store.listEvents(taskId);
      if (hasPersistedRuntimeObservation(events, input)) return;
      if (usageSnapshotIsSuperseded(events, input)) return;
      const removable = compactedRuntimeObservationIds(events, input);
      if (removable.length > 0) store.removeEvents(taskId, removable);
      const observationEventId = store.nextEventId(taskId);
      const observationEvent = createTaskEvent(
        observationEventId,
        taskId,
        RUNTIME_OBSERVATION_TASK_EVENT,
        runtimeObservationTaskEventPayload(input),
        now
      );
      store.saveEvent(taskId, observationEvent);
      if (input.kind === "native-work.snapshot"
        && input.payload.snapshotComplete === true
        && input.payload.observationQuality === "exact") {
        for (const continuation of projectProviderContinuations(events)) {
          if (continuation.turnId !== input.fence.turnId
            || continuation.identity.conversationId !== input.fence.conversationId
            || continuation.identity.activationId !== input.fence.activationId
            || continuation.execution === "quiescent") continue;
          const identityKey = providerContinuationKey(continuation.identity);
          const digest = createHash("sha256")
            .update(`${input.semanticKey}\u0000${identityKey}`)
            .digest("hex");
          const settled = createRuntimeObservation({
            schemaVersion: 4,
            eventId: `native-snapshot-settled:${digest}`,
            semanticKey: `native-snapshot-settled:${digest}`,
            kind: "continuation.settled",
            authority: "controller",
            receivedAt: input.receivedAt,
            observedAt: input.observedAt ?? input.receivedAt,
            fence: {
              ...input.fence,
              continuationId: continuation.identity.continuationId,
              continuationGeneration: continuation.identity.generation,
              ...(continuation.parentContinuationId === undefined
                ? {}
                : { parentContinuationId: continuation.parentContinuationId })
            },
            payload: {
              execution: "quiescent",
              outcome: "unknown",
              attachment: continuation.attachment,
              observationQuality: "exact",
              mayWriteWorkspace: false,
              ...(continuation.resultRef === undefined
                ? {}
                : { resultRef: continuation.resultRef })
            }
          });
          const settledEventId = store.nextEventId(taskId);
          const settledEvent = createTaskEvent(
            settledEventId,
            taskId,
            RUNTIME_OBSERVATION_TASK_EVENT,
            runtimeObservationTaskEventPayload(settled),
            now
          );
          store.saveEvent(taskId, settledEvent);
          routeContinuationResult(
            store,
            settled,
            settledEvent,
            "provider-continuation-settled",
            now
          );
        }
      }
      if (input.kind === "continuation.reported"
        || input.kind === "continuation.settled") {
        routeContinuationResult(
          store,
          input,
          observationEvent,
          input.kind === "continuation.reported"
            ? "provider-continuation-report"
            : "provider-continuation-settled",
          now
        );
      }
      if ((input.kind === "goal.cleared"
          || (input.kind === "goal.updated" && input.payload.goalStatus !== "active"))
        && input.fence.roleName !== "leader") {
        routeRoleEvent(
          store,
          observationEvent,
          input.fence.roleName,
          input.kind === "goal.cleared"
            ? "provider-goal-cleared"
            : `provider-goal-${input.payload.goalStatus}`,
          now
        );
      }
      if (input.kind === "turn.failed" && input.payload.failure !== undefined) {
        const failure = input.payload.failure;
        const error = failure.error;
        const run = input.fence.turnId === undefined
          ? null
          : store.getTurn(taskId, input.fence.turnId);
        const errorEvent = createTaskEvent(
          store.nextEventId(taskId),
          taskId,
          "runtime.agent-error",
          {
            sourceEventId: input.eventId,
            observationEventId,
            turnId: input.fence.turnId ?? "",
            roleName: input.fence.roleName,
            agentId: input.fence.agentId,
            adapterId: run?.effective.adapterId ?? "unknown",
            driverId: input.fence.driverId,
            runtimeGenerationId: input.fence.runtimeGenerationId,
            nativeSessionId: input.fence.nativeSessionId ?? "",
            nativeTurnId: input.fence.nativeTurnId ?? "",
            source: error.source,
            phase: error.phase,
            category: error.category,
            code: error.code,
            message: error.message,
            raw: error.raw,
            inputDisposition: error.inputDisposition,
            sessionDisposition: error.sessionDisposition,
            ...(error.retryAfterMs === undefined
              ? {}
              : { retryAfterMs: String(error.retryAfterMs) }),
            ...(failure.lastOutput === undefined ? {} : { lastOutput: failure.lastOutput })
          },
          now
        );
        store.saveEvent(taskId, errorEvent);
        enqueueWork(
          store,
          { kind: "role", taskId, roleName: "leader" },
          wakeReason("agent-error", errorEvent.id),
          now,
          [{ type: "event", taskId, id: errorEvent.id }],
          {
            source: input.fence.driverId,
            dedupeKey: `agent-error:${taskId}:${input.eventId}`
          }
        );
        if (input.fence.roleName === "leader"
          && error.sessionDisposition === "unrecoverable") {
          enqueueWork(
            store,
            { kind: "operator" },
            "leader-session-unrecoverable",
            now,
            [{ type: "event", taskId, id: errorEvent.id }],
            {
              source: input.fence.driverId,
              dedupeKey: `leader-session-unrecoverable:${taskId}:${input.eventId}`
            }
          );
        }
      }
      if ((input.kind === "operation.completed" || input.kind === "operation.failed")
        && input.payload.operation === "subagent") {
        const role = store.getRole(taskId, input.fence.roleName);
        const session = store.getRoleSession(
          taskId,
          input.fence.roleName
        );
        // A live provider Session owns delivery of its native child result.
        // Route a Yui wake only when that parent is gone and another observer
        // supplied the child's terminal fact.
        if (role !== null && session?.status === "ended") {
          routeRoleEvent(
            store,
            observationEvent,
            role.name,
            "detached-native-subagent-terminal",
            now
          );
        }
      }
    });
    if (this.telemetry !== null && input.fence.turnId !== undefined) {
      try {
        const entry = runtimeObservationTelemetryEntry(input);
        this.telemetry.sink.observe(entry);
        const run = this.store.getTurn(entry.taskId, input.fence.turnId);
        if (run !== null && run.status !== "active") {
          void this.telemetry.retention.flush().then(() => {
            this.telemetry?.retention.pruneGeneration(
              entry.taskId,
              entry.roleName,
              entry.turnId,
              entry.generation
            );
          }).catch(() => undefined);
        }
      } catch {
        // Runtime telemetry is diagnostic; the compact durable state snapshot
        // above remains authoritative when a sidecar is unavailable.
      }
    }
  }

  private recordObsoleteCanonicalObservation(
    input: RuntimeObservation,
    reason: string,
    now: Date
  ): "obsolete" {
    const taskId = input.fence.taskId;
    if (taskId === undefined || this.store.getTask(taskId) === null) return "obsolete";
    this.store.transaction((store) => recordCanonicalObservationObsolete(store, input, reason, now));
    return "obsolete";
  }

  /**
   * Revision-scoped read projection. Keyed by the store's durable revision;
   * any committed mutation (ours or an external writer's) advances it and the
   * next read rebuilds. A store without getStateRevision disables caching.
   */
  #readProjection: {
    revision: number;
    tasks: Map<string, TaskReadProjection>;
  } | null = null;

  #taskReadProjection(taskId: string): TaskReadProjection {
    const revision = typeof this.store.getStateRevision === "function"
      ? this.store.getStateRevision()
      : Number.NaN;
    if (
      this.#readProjection === null
      || this.#readProjection.revision !== revision
    ) {
      this.#readProjection = { revision, tasks: new Map() };
    }
    const tasks = this.#readProjection.tasks;
    let task = tasks.get(taskId);
    if (task === undefined) {
      const events = this.store.listEvents(taskId);
      task = {
        events,
        turnFacts: foldTurnProgressFacts(events),
        turns: this.store.listTurns(taskId),
        workItems: this.store.listWorkItems(taskId),
        reviewRounds: this.store.listReviewRounds(taskId),
        changeSets: this.store.listChangeSets(taskId),
        integrationAttempts: this.store.listIntegrationAttempts(taskId),
        inputRequests: this.store.listInputRequests(taskId),
        durableJobs: this.store.listDurableJobs(taskId),
        messages: this.store.listMessages(taskId)
      };
      tasks.set(taskId, task);
    }
    return task;
  }

  withRuntimeEventTransaction<T>(execute: () => T): T {
    return this.store.withRuntimeEventTransaction(execute);
  }

  listTasks() { return this.store.listTasks(); }
  listActiveTaskIds(): readonly string[] {
    return [...this.store.listActiveTaskIds()].sort((left, right) => (
      left.localeCompare(right, undefined, { numeric: true })
    ));
  }
  getTask(taskId: string) { return this.store.getTask(taskId); }
  getTaskWorkspace(taskId: string) { return this.store.getTaskWorkspace(taskId); }
  getTaskBrief(taskId: string) { return this.store.getTaskBrief(taskId); }
  listDecisions(taskId: string) { return this.store.listDecisions(taskId); }
  listMilestones(taskId: string) { return this.store.listMilestones(taskId); }
  getTaskWakeEnvelope(taskId: string): WakeEnvelope | null {
    return this.store.transaction((reader) => {
      const pending = reader.getPendingWakeup(taskId);
      if (pending === null) return null;
      const task = reader.getTask(taskId);
      if (task === null) return null;
      const latest = latestTaskWake(reader.listTaskWakes(taskId));
      const fromCursor = latest?.toCursor ?? fallbackWakeCursor({
        taskCreatedAt: task.createdAt,
        leaderTurnCreatedAt: operationalTaskRecords(
          reader.listTurns(taskId),
          reader.listEvents(taskId),
          "turn"
        )
          .filter((run) => run.roleName === "leader")
          .at(-1)?.createdAt
      });
      return buildTaskWakeEnvelope(reader, {
        taskId,
        wakeId: reader.peekNextTaskWakeId(taskId),
        reasons: pending.reasons,
        fromCursor
      });
    });
  }
  listRoles(taskId: string): SchedulerRole[] {
    return this.store.listRoles(taskId).map((role) => mapRole(this.store, role));
  }

  getRole(taskId: string, roleName: string): SchedulerRole | null {
    const role = this.store.getRole(taskId, roleName);
    return role === null ? null : mapRole(this.store, role);
  }

  getActiveTurn(taskId: string, roleName: string) {
    return this.store.getActiveTurn(taskId, roleName);
  }

  hasOpenInputRequest(taskId: string): boolean {
    return this.store.listOpenInputRequests([taskId]).length > 0;
  }

  listOpenInputRequests(taskIds?: readonly string[]) {
    return this.store.listOpenInputRequests(taskIds);
  }

  getInputRequest(taskId: string, inputRequestId: string) {
    return this.store.getInputRequest(taskId, inputRequestId);
  }

  getOperatorDeliveryTarget() {
    const role = this.store.getGlobalRole(SYSTEM_OPERATOR_ROLE);
    if (role === null) return null;
    const sessions = this.store.getGlobalRoleSessionSet(SYSTEM_OPERATOR_ROLE);
    const effectiveSession = sessions?.sessions[sessions.activeAgentId];
    if (effectiveSession?.status !== "active") return null;
    return {
      roleName: SYSTEM_OPERATOR_ROLE,
      adapterId: effectiveSession.effective.adapterId
    } as const;
  }

  markOperatorTurnStarted(now: Date): void {
    void now;
  }

  resolveExpiredInputRecommendations(now: Date, taskIds?: ReadonlySet<string>) {
    return this.store.transaction((store) => {
      const selectedTaskIds = taskIds === undefined
        ? undefined
        : [...taskIds].sort((left, right) => (
            left.localeCompare(right, undefined, { numeric: true })
          ));
      const expired = store.listOpenInputRequests(selectedTaskIds).filter((request) => (
        request.policy.kind === "recommended"
        && Date.parse(request.policy.timeoutAt) <= now.getTime()
      ));
      const resolved = [];
      for (const request of expired) {
        const task = store.getTask(request.taskId);
        if (task?.status !== "active"
          || task.executionGate.state !== "enabled"
          || request.policy.kind !== "recommended") continue;
        const choiceKey = request.policy.recommendedChoiceKey;
        const answered = answerInputRequest(
          request,
          { choiceKey },
          "agent-timeout",
          now
        );
        store.saveInputRequest(task.id, answered);
        store.saveEvent(task.id, createTaskEvent(
          store.nextEventId(task.id),
          task.id,
          "input.auto-answered",
          { requestId: request.id, choiceKey },
          now
        ));
        queueLeaderWakeup(store, task.id, wakeReason("input-timeout", request.id), now);
        resolved.push({ inputRequestId: request.id, taskId: task.id, choiceKey });
      }
      return resolved;
    });
  }

  getRoleSession(
    taskId: string,
    roleName: string,
    agentId?: string
  ): SchedulerRoleSession | null {
    const sessions = this.store.getTaskRoleSessionSet(taskId, roleName);
    const session = agentId === undefined
      ? sessions?.sessions[sessions.activeAgentId]
      : sessions?.sessions[agentId];
    return session === undefined ? null : mapSession(session);
  }

  getTaskRoleSessionSet(taskId: string, roleName: string): TaskRoleSessionSet | null {
    return this.store.getTaskRoleSessionSet(taskId, roleName);
  }

  listEvents(taskId: string) {
    return this.#taskReadProjection(taskId).events;
  }

  listTurns(taskId: string) {
    return this.#taskReadProjection(taskId).turns;
  }

  listWorkItems(taskId: string) {
    return this.#taskReadProjection(taskId).workItems;
  }

  listReviewRounds(taskId: string) {
    return this.#taskReadProjection(taskId).reviewRounds;
  }

  listIntegrationAttempts(taskId: string) {
    return this.#taskReadProjection(taskId).integrationAttempts;
  }

  listDurableJobs(taskId: string) {
    return this.#taskReadProjection(taskId).durableJobs;
  }

  listInputRequests(taskId: string) {
    return this.#taskReadProjection(taskId).inputRequests;
  }

  listMessages(taskId: string) {
    return this.#taskReadProjection(taskId).messages;
  }

  getTurnProgressFacts(taskId: string, turnId: string): TurnProgressFacts | undefined {
    return this.#taskReadProjection(taskId).turnFacts.get(turnId);
  }

  getTurnDurableProgress(
    taskId: string,
    roleName: string,
    turnId: string
  ): SchedulerTurnProgress | null {
    const projected = this.#taskReadProjection(taskId);
    // Serve the related-record fold from the same revision's projection: the
    // event history and the WorkItem/Review/ChangeSet/Integration/Input lists
    // are read once per Task per revision, and the per-Turn checkpoint/activity
    // facts come from the one-pass fold instead of per-candidate scans.
    const view = {
      getTurn: (id: string, turnId: string) => this.store.getTurn(id, turnId),
      listEvents: () => projected.events,
      getWorkItem: (id: string, workItemId: string) => this.store.getWorkItem(id, workItemId),
      listReviewRounds: () => projected.reviewRounds,
      listChangeSets: () => projected.changeSets,
      listIntegrationAttempts: () => projected.integrationAttempts,
      listInputRequests: () => projected.inputRequests
    };
    // A missing fold entry is an authoritative empty fold, not a signal to
    // re-scan the whole history. Pass {} so latestTurnDurableProgressAt treats
    // the fold as present and skips the per-candidate fallback scans.
    return latestTurnDurableProgressAt(view, taskId, roleName, turnId, projected.turnFacts.get(turnId) ?? {});
  }

  recordRoleTurnDiagnostic(
    input: RoleTurnDiagnosticPersistence
  ): "recorded" | "already-recorded" | "state-changed" {
    return this.store.transaction((store) => {
      const task = store.getTask(input.taskId);
      const run = store.getActiveTurn(input.taskId, input.roleName);
      if (task === null || task.status !== "active" || task.executionGate.state !== "enabled"
        || run === null || run.id !== input.turnId || run.status !== "active") {
        return "state-changed";
      }
      const latest = latestTurnEventTime(
        store.listEvents(input.taskId),
        TURN_DIAGNOSTIC_FINISHED_EVENT,
        input.turnId
      );
      if (latest !== undefined && Date.parse(latest) >= Date.parse(input.startedAt)) {
        return "already-recorded";
      }
      store.saveEvent(input.taskId, createTaskEvent(
        store.nextEventId(input.taskId),
        input.taskId,
        TURN_DIAGNOSTIC_FINISHED_EVENT,
        {
          turnId: input.turnId,
          roleName: input.roleName,
          outcome: input.outcome,
          startedAt: input.startedAt
        },
        input.now
      ));
      return "recorded";
    });
  }

  recordRoleTurnStall(
    input: RoleTurnStallPersistence
  ): "raised" | "already-raised" | "state-changed" {
    return this.store.transaction((store) => {
      const task = store.getTask(input.taskId);
      const role = store.getRole(input.taskId, input.roleName);
      const run = store.getActiveTurn(input.taskId, input.roleName);
      if (
        task === null
        || task.status !== "active"
        || task.executionGate.state !== "enabled"
        || role === null
        || run === null
        || run.id !== input.turnId
        || run.status !== "active"
        || run.effective.agentId !== input.agentId
        || run.effective.adapterId !== input.adapterId
      ) return "state-changed";

      const progress = latestTurnDurableProgressAt(
        store,
        input.taskId,
        input.roleName,
        input.turnId
      );
      if (progress?.progressAt !== input.progressAt) return "state-changed";

      const session = store.getRoleSession(input.taskId, input.roleName);
      if (!matchesStallSessionFence(session, input.session)) return "state-changed";

      const existing = latestStallEvidenceKey(store.listEvents(task.id), run.id);
      if (existing?.progressAt === input.progressAt) return "already-raised";

      const event = createTaskEvent(
        store.nextEventId(task.id),
        task.id,
        TURN_STALLED_EVENT,
        {
          turnId: run.id,
          roleName: role.name,
          kind: input.kind,
          classification: input.classification,
          progressAt: input.progressAt,
          idleMs: String(Math.max(0, Math.floor(input.idleMs))),
          evidenceKey: input.evidenceKey,
          status: "diagnostic-only"
        },
        input.now
      );
      store.saveEvent(task.id, event);
      return "raised";
    });
  }

  recordRoleTurnProgress(
    input: RoleTurnProgressPersistence
  ): "recorded" | "already-recorded" | "state-changed" {
    return this.store.transaction((store) => {
      const task = store.getTask(input.taskId);
      const run = store.getActiveTurn(input.taskId, input.roleName);
      if (
        task === null
        || task.status !== "active"
        || task.executionGate.state !== "enabled"
        || run === null
        || run.id !== input.turnId
        || run.status !== "active"
      ) return "state-changed";
      const events = store.listEvents(task.id);
      const previousStall = latestStallEvidenceKey(events, run.id);
      // A progress fact can close only the matching, older stall episode. A
      // stale/native observation must never clear a newer attention point.
      if (
        previousStall !== undefined
        && Date.parse(input.progressAt) <= Date.parse(previousStall.progressAt)
      ) {
        return "already-recorded";
      }
      const existing = events.some((event) => (
        event.type === TURN_PROGRESS_EVENT
        && event.payload.turnId === run.id
        && (
          event.payload.progressAt === input.progressAt
          || (
            typeof event.payload.progressAt === "string"
            && Number.isFinite(Date.parse(event.payload.progressAt))
            && Date.parse(event.payload.progressAt) >= Date.parse(input.progressAt)
          )
        )
      ));
      // Advisory 30-minute diagnostics are intentionally not lifecycle
      // episodes and therefore must never synthesize turn.recovered.
      const recovered = isRoleTurnStalled(events, run.id);
      if (!existing) {
        store.saveEvent(task.id, createTaskEvent(
          store.nextEventId(task.id),
          task.id,
          TURN_PROGRESS_EVENT,
          {
            turnId: run.id,
            roleName: input.roleName,
            kind: "durable-fold",
            progressAt: input.progressAt,
            evidence: input.evidence ?? ""
          },
          input.now
        ));
      }
      if (recovered) {
        store.saveEvent(task.id, createTaskEvent(
          store.nextEventId(task.id),
          task.id,
          TURN_RECOVERED_EVENT,
          {
            turnId: run.id,
            roleName: input.roleName,
            progressAt: input.progressAt,
            kind: "durable-progress"
          },
          input.now
        ));
      }
      return existing && !recovered ? "already-recorded" : "recorded";
    });
  }

  beginAgentHostProviderTurn(input: Readonly<{
    taskId: string;
    roleName: string;
    turnId?: string;
    agentId: string;
    runtimeGenerationId: string;
    nativeSessionId: string;
    attemptId: string;
    authorityEpoch: number;
    authorityOwner: "controller" | "human";
    holderId: string;
    now: Date;
  }>): void {
    this.store.transaction((store) => {
      const sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName);
      const session = sessions?.sessions[input.agentId];
      const binding = sessions?.providerBinding;
      const active = store.getActiveTurn(input.taskId, input.roleName);
      if (sessions === null || sessions === undefined
        || binding === null || binding === undefined
        || (input.turnId !== undefined
          && (active?.id !== input.turnId || active.effective.agentId !== input.agentId))
        || session?.runtimeGenerationId !== input.runtimeGenerationId
        || session.nativeSessionId !== input.nativeSessionId
        || currentProviderConversation(binding).conversationId !== input.nativeSessionId
        || binding.authority.owner !== input.authorityOwner
        || binding.authority.epoch !== input.authorityEpoch
        || binding.authority.holderId !== input.holderId) {
        throw new AgentHostProviderTurnFenceError(
          "Agent Host Provider Turn carries a stale durable writer fence. Release and reacquire Provider authority before retrying input."
        );
      }
      const currentTurn = binding.turn;
      const exactReplay = currentTurn !== null
        && currentTurn.turnId === input.turnId
        && currentTurn.attemptId === input.attemptId
        && currentTurn.authorityEpoch === input.authorityEpoch
        && currentTurn.status === "submitting";
      if (!exactReplay && binding.turn !== null
        && ["submitting", "accepted", "delivery-unknown"]
          .includes(binding.turn.status)) {
        throw new AgentHostProviderTurnFenceError(
          "Provider Conversation already has an unsettled Turn."
        );
      }
      store.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(
        sessions,
        beginProviderTurn(binding, {
          ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
          attemptId: input.attemptId,
          authorityEpoch: input.authorityEpoch,
          submittedAt: input.now.toISOString()
        }),
        input.now
      ));
    });
  }

  resolveAgentHostProviderTurnSubmission(input: Readonly<{
    taskId: string;
    roleName: string;
    turnId?: string;
    attemptId: string;
    status: "rejected" | "delivery-unknown";
    reason: string;
    raw: string;
    now: Date;
  }>): void {
    this.store.transaction((store) => {
      const sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName);
      const binding = sessions?.providerBinding;
      if (sessions === null || sessions === undefined
        || binding === null || binding === undefined
        || binding.turn?.turnId !== input.turnId
        || binding.turn?.attemptId !== input.attemptId) {
        throw new Error("Agent Host Provider Turn submission is no longer current.");
      }
      const updated = settleProviderTurnSubmission(binding, {
        attemptId: input.attemptId,
        status: input.status,
        reason: input.reason,
        resolvedAt: input.now.toISOString()
      });
      store.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(sessions, updated, input.now));
      if (input.turnId === undefined) return;
      const run = store.getTurn(input.taskId, input.turnId);
      const session = sessions.sessions[sessions.activeAgentId];
      const driver = run === null
        ? null
        : this.drivers.findByAdapterId(run.effective.adapterId);
      const error = standardAgentError({
        source: "driver",
        phase: "turn-submit",
        classification: driver?.runtime.mapError({
          message: input.reason,
          raw: input.raw
        }),
        message: input.reason,
        raw: input.raw,
        inputDisposition: input.status === "rejected" ? "not-accepted" : "unknown"
      });
      const errorEvent = createTaskEvent(
        store.nextEventId(input.taskId),
        input.taskId,
        "runtime.agent-error",
        {
          sourceEventId: input.attemptId,
          turnId: input.turnId,
          roleName: input.roleName,
          agentId: run?.effective.agentId ?? sessions.activeAgentId,
          adapterId: run?.effective.adapterId ?? session?.adapterId ?? "unknown",
          driverId: driver?.id ?? "unknown",
          runtimeGenerationId: session?.runtimeGenerationId ?? "",
          nativeSessionId: session?.nativeSessionId ?? "",
          nativeTurnId: "",
          source: error.source,
          phase: error.phase,
          category: error.category,
          code: error.code,
          message: error.message,
          raw: error.raw,
          inputDisposition: error.inputDisposition,
          sessionDisposition: error.sessionDisposition
        },
        input.now
      );
      store.saveEvent(input.taskId, errorEvent);
      const route = input.roleName === "leader"
        ? { kind: "operator" } as const
        : { kind: "role", taskId: input.taskId, roleName: "leader" } as const;
      enqueueWork(
        store,
        route,
        input.roleName === "leader"
          ? "leader-turn-submission-error"
          : wakeReason("agent-error", errorEvent.id),
        input.now,
        [{ type: "event", taskId: input.taskId, id: errorEvent.id }],
        {
          source: driver?.id ?? "agent-host",
          dedupeKey: `agent-error:${input.taskId}:${input.attemptId}`
        }
      );
    });
  }

  getProviderAuthorityFence(input: Readonly<{
    taskId: string;
    roleName: string;
    turnId: string;
    agentId: string;
    runtimeGenerationId: string;
    nativeSessionId: string;
  }>): Readonly<{
    conversationId: string;
    activationId: string;
    epoch: number;
    owner: "controller" | "human" | "none" | "unknown";
    holderId?: string;
  }> | null {
    const sessions = this.store.getTaskRoleSessionSet(input.taskId, input.roleName);
    const session = sessions?.sessions[input.agentId];
    const binding = sessions?.providerBinding;
    if (binding === null || binding === undefined
      || session?.runtimeGenerationId !== input.runtimeGenerationId
      || session.nativeSessionId !== input.nativeSessionId
      || currentProviderConversation(binding).conversationId !== input.nativeSessionId) return null;
    const activation = currentProviderActivation(binding);
    if (activation === null) return null;
    return {
      conversationId: currentProviderConversation(binding).conversationId,
      activationId: activation.activationId,
      ...binding.authority
    };
  }

  peekNextTurnId(taskId: string): string {
    return this.store.peekNextTurnId(taskId);
  }
  getWorkMailbox(target: MailboxTarget) { return this.store.getWorkMailbox(target); }
  listWorkMailboxes() { return this.store.listWorkMailboxes(); }
  listReadyWorkMailboxes() { return this.store.listReadyWorkMailboxes(); }

  queueTaskProgress(taskId: string, reason: string, now: Date): void {
    this.store.transaction((store) => {
      enqueueWork(store, { kind: "task", taskId }, reason, now, [
        { type: "task", id: taskId }
      ]);
    });
  }

  enqueueLeaderWakeup(taskId: string, reason: string, now: Date) {
    return this.store.transaction((store) => {
      const mailbox = enqueueWork(
        store,
        { kind: "role", taskId, roleName: "leader" },
        reason,
        now
      );
      const wakeup = pendingWakeupProjection(mailbox);
      if (wakeup === null) throw new Error(`Leader wakeup was not persisted: ${taskId}.`);
      return wakeup;
    });
  }

  recordAgentError(input: Readonly<{
    taskId: string;
    roleName: string;
    turnId: string;
    source: import("../runtime/agentError.js").AgentErrorSource;
    phase: import("../runtime/agentError.js").AgentErrorPhase;
    message: string;
    raw: string;
    inputDisposition?: import("../runtime/agentError.js").AgentErrorInputDisposition;
    sessionDisposition?: import("../runtime/agentError.js").AgentErrorSessionDisposition;
  }>, now: Date): string {
    return this.store.transaction((store) => {
      const duplicate = [...store.listEvents(input.taskId)].reverse().find((event) => (
        event.type === "runtime.agent-error"
        && event.payload.turnId === input.turnId
        && event.payload.phase === input.phase
        && event.payload.raw === input.raw
      ));
      if (duplicate !== undefined) return duplicate.id;
      const run = store.getTurn(input.taskId, input.turnId);
      const sessionSet = store.getTaskRoleSessionSet(input.taskId, input.roleName);
      const sessionAgentId = run?.effective.agentId ?? sessionSet?.activeAgentId;
      const session = sessionAgentId === undefined
        ? undefined
        : sessionSet?.sessions[sessionAgentId];
      const driver = run === null
        ? null
        : this.drivers.findByAdapterId(run.effective.adapterId);
      const error = standardAgentError({
        source: input.source,
        phase: input.phase,
        classification: driver?.runtime.mapError({
          message: input.message,
          raw: input.raw
        }),
        message: input.message,
        raw: input.raw,
        ...(input.inputDisposition === undefined
          ? {}
          : { inputDisposition: input.inputDisposition }),
        ...(input.sessionDisposition === undefined
          ? {}
          : { sessionDisposition: input.sessionDisposition })
      });
      const event = createTaskEvent(
        store.nextEventId(input.taskId),
        input.taskId,
        "runtime.agent-error",
        {
          sourceEventId: `${input.turnId}:${input.phase}`,
          turnId: input.turnId,
          roleName: input.roleName,
          agentId: run?.effective.agentId ?? session?.agentId ?? "unknown",
          adapterId: run?.effective.adapterId ?? session?.adapterId ?? "unknown",
          driverId: driver?.id ?? "unknown",
          runtimeGenerationId: session?.runtimeGenerationId ?? "",
          nativeSessionId: session?.nativeSessionId ?? "",
          nativeTurnId: "",
          source: error.source,
          phase: error.phase,
          category: error.category,
          code: error.code,
          message: error.message,
          raw: error.raw,
          inputDisposition: error.inputDisposition,
          sessionDisposition: error.sessionDisposition
        },
        now
      );
      store.saveEvent(input.taskId, event);
      const leaderCannotReceive = input.roleName === "leader"
        && ["host-start", "session-start", "session-restore", "turn-submit"].includes(
          input.phase
        );
      if (!leaderCannotReceive) {
        enqueueWork(
          store,
          { kind: "role", taskId: input.taskId, roleName: "leader" },
          wakeReason("agent-error", event.id),
          now,
          [{ type: "event", taskId: input.taskId, id: event.id }],
          {
            source: driver?.id ?? input.source,
            dedupeKey: `agent-error:${input.taskId}:${input.turnId}:${input.phase}:${event.id}`
          }
        );
      }
      if (leaderCannotReceive) {
        enqueueWork(
          store,
          { kind: "operator" },
          "leader-agent-error",
          now,
          [{ type: "event", taskId: input.taskId, id: event.id }],
          {
            source: driver?.id ?? input.source,
            dedupeKey: `leader-agent-error:${input.taskId}:${input.turnId}:${event.id}`
          }
        );
      }
      return event.id;
    });
  }

  /**
   * Records that a Leader wake was suppressed by scheduler single-flight
   * (the Role runtime lifecycle lane was busy). The wake stays durable and
   * is retried after the lane settles; this event is the audit trail that
   * separates scheduler backpressure from real Turn failures.
   */
  recordWakeSuppression(
    taskId: string,
    reason: string,
    now: Date
  ): void {
    this.store.transaction((store) => {
      const task = store.getTask(taskId);
      if (task === null) return;
      store.saveEvent(taskId, createTaskEvent(
        store.nextEventId(taskId),
        taskId,
        "wake.suppressed",
        { reason },
        now
      ));
    });
  }

  listActiveDurableJobs(): readonly DurableJob[] {
    return this.store.listActiveDurableJobs();
  }

  /**
   * Apply one durable-job transition and, in the SAME transaction, enqueue
   * the Leader wakeup. A terminal job without its wakeup enqueued is a lost
   * wakeup, so the two writes commit together or not at all.
   *
   * f6: The wakeup targets the Leader role mailbox (not the Task mailbox).
   * That mailbox is also the PendingWakeup authority consumed by
   * processLeaderWakeups, so the signal must be enqueued exactly once.
   */
  transitionDurableJob(
    taskId: string,
    jobId: string,
    transition: (job: DurableJob) => DurableJob,
    now: Date,
    wakeup?: { reason: string; refs: readonly MailboxEntityRef[] }
  ): DurableJob | null {
    return this.store.transaction((store) => {
      const current = store.getDurableJob(taskId, jobId);
      if (current === null) return null;
      const next = transition(current);
      store.saveDurableJob(taskId, next);
      if (wakeup !== undefined) {
        enqueueWork(
          store,
          { kind: "role", taskId, roleName: "leader" },
          wakeup.reason,
          now,
          [...wakeup.refs]
        );
      }
      return next;
    });
  }

  releaseLeaderWakeupAndEnqueue(
    taskId: string,
    batchId: string,
    reason: string,
    now: Date
  ): boolean {
    const target = { kind: "role", taskId, roleName: "leader" } as const;
    return this.store.transaction((store) => {
      const mailbox = store.getWorkMailbox(target);
      if (mailbox?.processing?.batchId !== batchId) return false;
      store.saveWorkMailbox(releaseProcessing(mailbox, batchId));
      enqueueWork(store, target, reason, now);
      return true;
    });
  }

  claimWorkMailbox(input: SchedulerMailboxClaimInput): SchedulerMailboxClaimResult {
    return this.store.transaction((store) => {
      const mailbox = store.getWorkMailbox(input.target);
      if (mailbox === null || !mailboxHasWork(mailbox)) {
        return { status: "empty" };
      }
      if (mailbox.processing !== null) {
        return { status: "processing", processing: mailbox.processing };
      }
      let claimed = claimPending(mailbox, {
        batchId: input.batchId,
        owner: input.owner,
        startedAt: input.now.toISOString()
      });
      if (input.executionRef !== undefined) {
        claimed = bindExecution(claimed, input.batchId, input.executionRef);
      }
      store.saveWorkMailbox(claimed);
      return { status: "claimed", processing: claimed.processing! };
    });
  }

  settleRoleTurnDispatch(
    input: Parameters<SchedulerStorePort["settleRoleTurnDispatch"]>[0]
  ): ReturnType<SchedulerStorePort["settleRoleTurnDispatch"]> {
    return this.store.transaction((store) => (
      settleRoleTurnDispatchMailbox(
        store,
        input,
        input.expected
      )
    ));
  }

  completeWorkMailbox(target: MailboxTarget, batchId: string): boolean {
    return this.store.transaction((store) => {
      const mailbox = store.getWorkMailbox(target);
      if (mailbox?.processing?.batchId !== batchId) return false;
      const completed = completeProcessing(mailbox, batchId);
      if (
        target.kind === "role-runtime"
        || target.kind === "global-role-runtime"
      ) {
        saveRuntimeLifecycleMailbox(store, completed);
      } else {
        store.saveWorkMailbox(completed);
      }
      return true;
    });
  }

  releaseWorkMailbox(target: MailboxTarget, batchId: string): boolean {
    return this.store.transaction((store) => {
      const mailbox = store.getWorkMailbox(target);
      if (mailbox?.processing?.batchId !== batchId) return false;
      store.saveWorkMailbox(releaseProcessing(mailbox, batchId));
      return true;
    });
  }

  completeRuntimeCleanup(
    target: Extract<
      MailboxTarget,
      { kind: "role-runtime" | "global-role-runtime" }
    >,
    now: Date
  ): boolean {
    return this.store.transaction((store) => {
      let mailbox = store.getWorkMailbox(target);
      const disposition = runtimeCleanupDisposition(mailbox);
      if (mailbox === null || disposition === null) return false;
      if (mailbox.processing !== null) {
        if (
          !isRuntimeLaunchReservation(mailbox.processing)
          && !mailbox.processing.batch.reasons.every(isRuntimeCleanupReason)
        ) {
          return false;
        }
        mailbox = completeProcessing(mailbox, mailbox.processing.batchId);
      }
      const pending = mailbox.pending;
      if (pending !== null) {
        if (
          pending.reasons.length === 0
          || !pending.reasons.every(isRuntimeCleanupReason)
        ) {
          return false;
        }
        const batchId = `runtime-cleanup-complete:${pending.fromSequence}-${pending.toSequence}`;
        mailbox = completeProcessing(claimPending(mailbox, {
          batchId,
          owner: RUNTIME_LIFECYCLE_OWNER,
          startedAt: now.toISOString()
        }), batchId);
      }
      const owner = runtimeOwnerFromTarget(target);
      if (disposition === "end-session") {
        endRuntimeOwnerSession(store, owner, now);
      } else {
        detachRuntimeOwnerHost(store, owner, now);
      }
      saveRuntimeLifecycleMailbox(store, mailbox);
      return true;
    });
  }

  completeStoppedRuntimeReservation(
    target: RuntimeLifecycleTarget,
    batchId: string,
    now: Date
  ): boolean {
    return this.store.transaction((store) => {
      const mailbox = store.getWorkMailbox(target);
      if (!isRuntimeLaunchReservation(mailbox?.processing, batchId)) {
        return false;
      }
      endRuntimeOwnerSession(store, runtimeOwnerFromTarget(target), now);
      saveRuntimeLifecycleMailbox(
        store,
        completeProcessing(mailbox!, batchId)
      );
      return true;
    });
  }

  listDormantRuntimeOwners(): readonly DormantRuntimeOwnerCandidate[] {
    return this.listRuntimeSessionCandidates().flatMap((candidate) => {
      if (
        hasRuntimeLifecycleWork(
          this.store.getWorkMailbox(runtimeLifecycleTarget(candidate.owner))
        )
        || (
          candidate.owner.scope === "task"
          && this.store.getActiveTurn(
            candidate.owner.taskId,
            candidate.owner.roleName
          ) !== null
        )
      ) {
        return [];
      }
      return [{
        owner: candidate.owner,
        agentId: candidate.agentId,
        adapterId: candidate.adapterId,
        nativeSessionId: candidate.nativeSessionId,
        ...(candidate.runtimeGenerationId === undefined ? {} : { runtimeGenerationId: candidate.runtimeGenerationId }),
        sessionUpdatedAt: candidate.sessionUpdatedAt
      }];
    });
  }

  listRuntimeSessionCandidates(
    query: RuntimeSessionCandidateQuery = {}
  ): readonly RuntimeSessionCandidate[] {
    return this.store.listRuntimeSessionCandidates(query);
  }

  enqueueRuntimeCleanup(
    owner: RuntimeRoleOwner,
    now = new Date(),
    expectedDormantCandidate?: DormantRuntimeOwnerCandidate
  ): RuntimeLifecycleTarget | null {
    return this.store.transaction((store) => {
      if (
        expectedDormantCandidate !== undefined
        && (
          !sameRuntimeOwner(owner, expectedDormantCandidate.owner)
          || !dormantRuntimeCandidateIsCurrent(store, expectedDormantCandidate)
        )
      ) {
        return null;
      }
      if (owner.scope === "task" && store.getTask(owner.taskId) === null) {
        return null;
      }
      const target = runtimeLifecycleTarget(owner);
      enqueueWork(
        store,
        target,
        RUNTIME_CLEANUP_REQUIRED_REASON,
        now,
        owner.scope === "task" ? [{ type: "task", id: owner.taskId }] : []
      );
      return target;
    });
  }

  enqueueRuntimeHostDetach(
    owner: RuntimeRoleOwner,
    now = new Date(),
    expectedDormantCandidate?: DormantRuntimeOwnerCandidate
  ): RuntimeLifecycleTarget | null {
    return this.store.transaction((store) => {
      if (
        expectedDormantCandidate !== undefined
        && (
          !sameRuntimeOwner(owner, expectedDormantCandidate.owner)
          || !dormantRuntimeCandidateIsCurrent(store, expectedDormantCandidate)
        )
      ) {
        return null;
      }
      if (owner.scope === "task" && store.getTask(owner.taskId) === null) {
        return null;
      }
      const target = runtimeLifecycleTarget(owner);
      enqueueWork(
        store,
        target,
        RUNTIME_HOST_DETACH_REQUIRED_REASON,
        now,
        owner.scope === "task" ? [{ type: "task", id: owner.taskId }] : []
      );
      return target;
    });
  }
  getPendingWakeup(taskId: string) { return this.store.getPendingWakeup(taskId); }
  listPendingWakeups() { return this.store.listPendingWakeups(); }
  savePendingWakeup(wakeup: Parameters<TaskStore["savePendingWakeup"]>[0]): void {
    this.store.savePendingWakeup(wakeup);
  }
  clearPendingWakeup(taskId: string): void { this.store.clearPendingWakeup(taskId); }
  getLeaderFailure(taskId: string) { return this.store.getLeaderFailure(taskId); }

  saveLeaderDispatch(input: LeaderDispatchPersistence): LeaderDispatchClaimResult {
    return this.store.transaction((store) => {
      const task = store.getTask(input.task.id);
      if (task === null || task.status !== "active" || task.executionGate.state !== "enabled") {
        return "unavailable";
      }
      const role = requireRole(store, input.task.id, input.role.name);
      const binding = activeRoleAgentBinding(role);
      if (role.activeAgentId !== input.role.activeAgentId
        || binding.adapterId !== input.role.adapterId
        || binding.config.model !== input.role.model
        || binding.config.effort !== input.role.effort
        || role.workspace !== input.role.workspace) {
        return "state-changed";
      }
      if (!isDeepStrictEqual(input.turn.effective, input.role.effective)) {
        return "state-changed";
      }
      if (store.getTurn(input.task.id, input.turn.id) !== null) return "state-changed";
      if (store.getActiveTurn(input.task.id, input.role.name) !== null) return "busy";
      const pending = store.getPendingWakeup(input.task.id);
      if (pending === null || !pendingWakeupsMatch(pending, input.wakeup)) {
        return "state-changed";
      }
      const target = { kind: "role", taskId: input.task.id, roleName: input.role.name } as const;
      const mailbox = store.getWorkMailbox(target);
      if (mailbox === null || !mailboxHasPending(mailbox)) return "state-changed";
      if (store.peekNextTurnId(input.task.id) !== input.turn.id) {
        return "state-changed";
      }
      const allocatedTurnId = store.nextTurnId(input.task.id);
      if (allocatedTurnId !== input.turn.id) {
        throw new Error(`Leader Turn allocation changed unexpectedly: ${input.task.id}.`);
      }
      // The durable Turn row and its active pointer are separate projections;
      // keep both writes in the same storage transaction.
      store.saveTurn(input.turn);
      store.saveActiveTurn(input.turn);
      store.saveWorkMailbox(consumePendingBatch(mailbox));
      store.clearPendingWakeup(input.task.id);
      store.saveEvent(input.task.id, createTaskEvent(
        store.nextEventId(input.task.id),
        input.task.id,
        "turn.dispatched",
        turnLaunchEventPayload(input.turn),
        input.now
      ));
      if (input.wakeId !== undefined && input.wakeFromCursor !== undefined) {
        if (store.peekNextTaskWakeId(input.task.id) !== input.wakeId) {
          return "state-changed";
        }
        const allocatedWakeId = store.nextTaskWakeId(input.task.id);
        if (allocatedWakeId !== input.wakeId) {
          throw new Error(`Leader TaskWake allocation changed unexpectedly: ${input.task.id}.`);
        }
        store.saveTaskWake(input.task.id, createTaskWake({
          id: allocatedWakeId,
          taskId: input.task.id,
          reasons: input.wakeup.reasons,
          fromCursor: input.wakeFromCursor,
          toCursor: input.now.toISOString(),
          turnId: input.turn.id,
          now: input.now
        }));
      }
      if (input.turn.mode !== "new"
        && input.session !== null
        && input.session.nativeSessionId !== undefined) {
        saveTaskSession(store, role, {
          ...input.session,
          nativeSessionId: input.session.nativeSessionId
        }, "active", input.now);
      }
      store.clearLeaderFailure(input.task.id);
      return "claimed";
    });
  }

  saveLeaderSteer(input: LeaderSteerPersistence): LeaderDispatchClaimResult {
    return this.store.transaction((store) => {
      const task = store.getTask(input.taskId);
      const active = store.getActiveTurn(input.taskId, "leader");
      if (task === null || task.status !== "active" || task.executionGate.state !== "enabled") {
        return "unavailable";
      }
      if (active === null || active.id !== input.turnId || active.status !== "active") return "busy";
      const target = { kind: "role", taskId: input.taskId, roleName: "leader" } as const;
      const mailbox = store.getWorkMailbox(target);
      const processing = mailbox?.processing;
      if (mailbox === null
        || processing?.batchId !== input.batchId
        || processing.owner !== `leader-steer:${input.turnId}`) return "state-changed";
      const updated = appendTurnInput(active, input.input, input.now);
      store.saveTurn(updated);
      store.saveActiveTurn(updated);
      store.saveWorkMailbox(completeProcessing(mailbox, input.batchId));
      store.saveEvent(input.taskId, createTaskEvent(
        store.nextEventId(input.taskId),
        input.taskId,
        "turn.input-submitted",
        {
          turnId: active.id,
          sequence: String(updated.inputs.length),
          source: `${input.input.source.type}/${input.input.source.channel}`,
          reasons: processing.batch.reasons.join(",")
        },
        input.now
      ));
      return "claimed";
    });
  }

  saveRoleTurnPrepared(input: RoleTurnDeliveryPersistence): void {
    this.store.transaction((store) => {
      const task = store.getTask(input.task.id);
      if (task === null || task.status !== "active" || task.executionGate.state !== "enabled") {
        throw new Error(`Task is not active: ${input.task.id}.`);
      }
      const role = requireRole(store, input.task.id, input.role.name);
      const active = store.getActiveTurn(input.task.id, input.role.name);
      if (active === null || active.id !== input.turn.id) {
        throw new Error(`Active Turn changed before preparation was persisted: ${input.turn.id}.`);
      }
      if (store.getTaskRoleSessionSet(input.task.id, input.role.name) === null) {
        store.saveTaskRoleSessionSet(createRoleSessionSet(
          { scope: "task", taskId: input.task.id, roleName: input.role.name },
          input.turn.effective.agentId,
          input.now
        ));
      }
      if (input.session !== null && input.session.nativeSessionId !== undefined) {
        const existing = store.getRoleSession(input.task.id, input.role.name);
        // A terminal Session is audit history, not the current execution
        // identity. Preallocated providers must publish the replacement fence
        // before the new Agent Host starts so its exact-runtime preflight sees
        // the new launch. Only a still-live conflicting Session is deferred.
        const defersConversationReplacement = active.mode === "new"
          && existing !== null
          && existing.nativeSessionId !== input.session.nativeSessionId
          && existing.status === "active";
        if (!defersConversationReplacement
          && (existing?.nativeSessionId !== input.session.nativeSessionId
          || (input.runtimeGenerationId !== undefined && existing.runtimeGenerationId !== input.runtimeGenerationId)
          || existing.status !== "active")) {
          saveTaskSession(store, role, {
            ...input.session,
            nativeSessionId: input.session.nativeSessionId
          }, "active", input.now, input.runtimeGenerationId);
        }
      }
    });
  }

  saveRoleTurnDeliveryFailure(
    input: RoleTurnDeliveryFailurePersistence
  ): "failed" | "state-changed" {
    return this.store.transaction((store) => {
      const task = store.getTask(input.taskId);
      const role = store.getRole(input.taskId, input.roleName);
      const active = store.getActiveTurn(input.taskId, input.roleName);
      const sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName);
      const session = sessions?.sessions[input.agentId];
      if (
        task === null
        || task.status !== "active"
        || task.executionGate.state !== "enabled"
        || role === null
        || active === null
        || active.id !== input.turnId
        || active.status !== "active"
        || active.effective.agentId !== input.agentId
        || active.effective.adapterId !== input.adapterId
      ) {
        return "state-changed";
      }

      const summary = input.summary
        ?? `Role delivery failed conclusively before exact Turn input acceptance: ${input.turnId}.`;
      const result = terminalizeExactTaskTurn(store, {
        taskId: input.taskId,
        roleName: input.roleName,
        agentId: input.agentId,
        turnId: input.turnId,
        ...(session?.nativeSessionId === undefined
          ? {}
          : { nativeSessionId: session.nativeSessionId }),
        ...(input.runtimeGenerationId === undefined ? {} : { runtimeGenerationId: input.runtimeGenerationId }),
        outcome: { status: "failed", diagnostic: summary, failureReason: input.failureReason }
      }, input.now);
      if (result.disposition !== "applied" || result.turn === null) {
        return "state-changed";
      }

      const terminal = result.turn;
      const deliveryFailureEvent = createTaskEvent(
        store.nextEventId(input.taskId),
        input.taskId,
        "runtime.role-delivery-failed",
        {
          turnId: terminal.id,
          roleName: input.roleName,
          outcome: terminal.status
        },
        input.now
      );
      store.saveEvent(input.taskId, deliveryFailureEvent);

      if (input.roleName !== "leader") {
        routeRoleEvent(
          store,
          deliveryFailureEvent,
          input.roleName,
          terminal.purpose === "review" ? "review-failed" : "role-turn-failed",
          input.now
        );
      } else {
        store.saveLeaderFailure(recordLeaderFailure(
          input.taskId,
          session?.nativeSessionId ?? "(unregistered)",
          summary,
          input.now,
          store.getLeaderFailure(input.taskId)
        ));
      }
      return "failed";
    });
  }

  /** Called by the internal Codex notify hook, never by an LLM prompt. */
  recordRuntimeNativeSession(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    runtimeGenerationId?: string;
    nativeSessionId: string;
  }>, now = new Date()): RoleAgentSession {
    return this.store.transaction((store) => (
      recordTaskRuntimeNativeSession(store, input, now)
    ));
  }

  reserveRuntimeLaunch(
    input: Readonly<{ owner: RuntimeRoleOwner; runtimeGenerationId: string }>,
    assertCurrent: () => void,
    now = new Date()
  ): Readonly<{
    status: "reserved" | "existing";
    runtimeGenerationId: string;
  }> {
    return this.store.transaction((store) => {
      assertCurrent();
      const target = runtimeLifecycleTarget(input.owner);
      const existing = store.getWorkMailbox(target);
      if (isRuntimeLaunchReservation(existing?.processing)) {
        if (hasRuntimeCleanupObligation(existing)) {
          throw new Error("Runtime cleanup is still pending.");
        }
        return {
          status: "existing",
          runtimeGenerationId: existing!.processing!.batchId
        };
      }
      if (hasRuntimeLifecycleWork(existing)) {
        throw new RuntimeLifecycleBusyError(
          "Runtime lifecycle work is already pending."
        );
      }
      enqueueWork(
        store,
        target,
        RUNTIME_LAUNCH_RESERVED_REASON,
        now,
        input.owner.scope === "task"
          ? [{ type: "task", id: input.owner.taskId } as const]
          : []
      );
      const queued = store.getWorkMailbox(target);
      if (queued === null
        || queued.pending === null
        || queued.processing !== null) {
        throw new Error("Runtime launch reservation could not be queued.");
      }
      const claimed = claimPending(queued, {
        batchId: input.runtimeGenerationId,
        owner: RUNTIME_LIFECYCLE_OWNER,
        startedAt: now.toISOString()
      });
      store.saveWorkMailbox(claimed);
      return {
        status: "reserved",
        runtimeGenerationId: input.runtimeGenerationId
      };
    });
  }

  confirmRuntimeLaunchReservation(
    input: Readonly<{ owner: RuntimeRoleOwner; runtimeGenerationId: string }>,
    assertCurrent: () => void
  ): "reserved" | "provider-bound" {
    return this.store.transaction((store) => {
      assertCurrent();
      const mailbox = store.getWorkMailbox(runtimeLifecycleTarget(input.owner));
      if (isRuntimeLaunchReservation(mailbox?.processing, input.runtimeGenerationId)) {
        return "reserved" as const;
      }
      if (hasRuntimeCleanupObligation(mailbox)) {
        throw new Error("Runtime cleanup is still pending.");
      }
      // A synchronous Driver Hook may bind a fresh native Session
      // and complete the reservation while the host start call is still
      // unwinding. Preserve that exact hook-won generation instead of treating
      // the already-settled reservation as a launch failure.
      const sessions = runtimeOwnerSessionSet(store, input.owner);
      const active = sessions?.sessions[sessions.activeAgentId];
      if (
        active?.status === "active"
        && active.runtimeGenerationId === input.runtimeGenerationId
      ) return "provider-bound" as const;
      throw new Error("Runtime launch reservation no longer matches the launch.");
    });
  }

  recordReservedRuntimeNativeSession(input: Readonly<{
    owner: RuntimeRoleOwner;
    runtimeGenerationId: string;
    agentId: string;
    adapterId: string;
    nativeSessionId: string;
    effective: EffectiveLaunchSnapshot;
  }>, assertCurrent: () => void, now = new Date()): RoleAgentSession {
    return this.store.transaction((store) => {
      assertCurrent();
      const mailbox = requireRuntimeLaunchReservation(
        store,
        input.owner,
        input.runtimeGenerationId
      );
      if (hasRuntimeCleanupObligation(mailbox)) {
        throw new Error("Runtime cleanup is still pending.");
      }
      const session = input.owner.scope === "task"
        ? recordTaskRuntimeNativeSession(store, {
            taskId: input.owner.taskId,
            roleName: input.owner.roleName,
            agentId: input.agentId,
            adapterId: input.adapterId,
            nativeSessionId: input.nativeSessionId,
            runtimeGenerationId: input.runtimeGenerationId,
            effective: input.effective
          }, now)
        : recordGlobalRuntimeNativeSession(store, {
            roleName: input.owner.roleName,
            agentId: input.agentId,
            adapterId: input.adapterId,
            nativeSessionId: input.nativeSessionId,
            runtimeGenerationId: input.runtimeGenerationId,
            effective: input.effective
          }, now);
      saveRuntimeLifecycleMailbox(
        store,
        completeProcessing(mailbox, input.runtimeGenerationId)
      );
      return session;
    });
  }

  completeRuntimeLaunchReservation(
    owner: RuntimeRoleOwner,
    runtimeGenerationId: string,
    beforeComplete?: () => void
  ): boolean {
    return this.store.transaction((store) => {
      const target = runtimeLifecycleTarget(owner);
      const mailbox = store.getWorkMailbox(target);
      if (!isRuntimeLaunchReservation(mailbox?.processing, runtimeGenerationId)) return false;
      beforeComplete?.();
      saveRuntimeLifecycleMailbox(
        store,
        completeProcessing(mailbox!, runtimeGenerationId)
      );
      return true;
    });
  }

  /**
   * Atomically settles a launch whose host is confirmed absent.
   *
   * The exact reservation is authoritative. If its matching Hook won the
   * transaction race and already cleared that reservation, the session
   * fallback is permitted only while the same Agent/native identity remains
   * current and no later lifecycle work or Task Turn exists.
   */
  settleStoppedRuntimeLaunch(input: Readonly<{
    owner: RuntimeRoleOwner;
    runtimeGenerationId: string;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
  }>, now = new Date()): boolean {
    return this.store.transaction((store) => {
      const target = runtimeLifecycleTarget(input.owner);
      const mailbox = store.getWorkMailbox(target);
      if (isRuntimeLaunchReservation(mailbox?.processing, input.runtimeGenerationId)) {
        const sessions = runtimeOwnerSessionSet(store, input.owner);
        const active = sessions?.sessions[sessions.activeAgentId];
        if (runtimeSessionMatchesSettledLaunch(active, input)) {
          endRuntimeOwnerSession(store, input.owner, now);
        }
        saveRuntimeLifecycleMailbox(
          store,
          completeProcessing(mailbox!, input.runtimeGenerationId)
        );
        return true;
      }
      if (hasRuntimeLifecycleWork(mailbox)) return false;
      if (
        input.owner.scope === "task"
        && store.getActiveTurn(
          input.owner.taskId,
          input.owner.roleName
        ) !== null
      ) {
        return false;
      }
      const sessions = runtimeOwnerSessionSet(store, input.owner);
      if (sessions === null) return true;
      const active = sessions.sessions[sessions.activeAgentId];
      if (!runtimeSessionMatchesSettledLaunch(active, input)) return false;
      if (active.status !== "ended") {
        endRuntimeOwnerSession(store, input.owner, now);
      }
      return true;
    });
  }

  /**
   * Fast hook path: validates the native Turn boundary before it is either
   * retained as an intermediate child wait or recorded as a ready boundary
   * for later mailbox input. It never performs tmux, workspace, or Controller I/O.
   */
  classifyRuntimeTurnTerminal(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    runtimeGenerationId?: string;
    nativeSessionId: string;
    nativeTurnId: string;
    attemptId?: string;
    turnId?: string;
    providerStatus: "completed" | "failed" | "cancelled";
    outcome: RuntimeTurnTerminalOutcome;
  }>): "apply" | "deferred" | "obsolete" {
    const task = this.store.getTask(input.taskId);
    const role = this.store.getRole(input.taskId, input.roleName);
    if (task === null || task.status === "archived" || role === null) return "obsolete";
    const sessions = this.store.getTaskRoleSessionSet(input.taskId, input.roleName);
    const existing = sessions?.sessions[input.agentId];
    const owner = {
      scope: "task" as const,
      taskId: input.taskId,
      roleName: input.roleName
    };
    if (
      existing === undefined
      && !runtimeHookMatchesReservation(this.store, owner, input.runtimeGenerationId)
    ) return "obsolete";
    try {
      const effectiveExisting = nativeTransitionExisting(
        this.store,
        owner,
        existing,
        input.nativeSessionId,
        input.runtimeGenerationId,
        "Runtime turn completion conflicts with the fixed Role session."
      );
      const effective = taskSessionEffective(
        this.store,
        input.taskId,
        input.roleName,
        input.agentId,
        effectiveExisting
      );
      if (effective.agentId !== input.agentId || effective.adapterId !== input.adapterId) {
        return "obsolete";
      }
    } catch {
      return "obsolete";
    }
    const providerTurn = sessions?.providerBinding?.turn;
    const canonicalTurnId = sessions === null || sessions === undefined
      ? input.nativeTurnId
      : canonicalStructuredProviderTurnId(
          sessions,
          input.nativeTurnId,
          input.attemptId
        );
    const recordedProviderTurn = providerTurn !== null
      && providerTurn !== undefined
      && providerTurn.nativeTurnId === input.nativeTurnId
      && providerTurn.nativeTurnId === canonicalTurnId;
    if (recordedProviderTurn) {
      if (input.turnId === undefined) return "apply";
      const run = this.store.getTurn(input.taskId, input.turnId);
      return run === null ? "obsolete" : "apply";
    }
    const active = this.store.getActiveTurn(input.taskId, input.roleName);
    if (input.turnId === undefined) return active === null ? "apply" : "obsolete";
    return active?.id === input.turnId ? "apply" : "obsolete";
  }

  observeRuntimeTurnTerminal(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    runtimeGenerationId?: string;
    nativeSessionId: string;
    nativeTurnId: string;
    attemptId?: string;
    turnId?: string;
    input?: string;
    providerStatus: "completed" | "failed" | "cancelled";
    outcome: RuntimeTurnTerminalOutcome;
  }>, now = new Date()): Readonly<{
    session: RoleAgentSession;
    duplicate: boolean;
    turn?: Turn;
    disposition?: "obsolete";
  }> {
    return this.store.transaction((store) => {
      const task = store.getTask(input.taskId);
      if (task === null) throw new Error(`Task not found: ${input.taskId}.`);
      if (task.status !== "active" && task.status !== "completed") {
        throw new Error(`Cannot complete a runtime turn for unavailable Task: ${input.taskId}.`);
      }
      const role = requireRole(store, input.taskId, input.roleName);
      let sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName)
        ?? createRoleSessionSet(
          { scope: "task", taskId: input.taskId, roleName: input.roleName },
          input.agentId,
          now
        );
      const canonicalTurnId = canonicalStructuredProviderTurnId(
        sessions,
        input.nativeTurnId,
        input.attemptId
      );
      const providerTurn = sessions.providerBinding?.turn;
      const recordedProviderTurn = providerTurn !== null
        && providerTurn !== undefined
        && providerTurn.nativeTurnId === input.nativeTurnId
        && providerTurn.nativeTurnId === canonicalTurnId;
      const observedTurn = input.turnId === undefined
        ? store.listTurns(input.taskId).find((turn) => (
            turn.result?.provider?.nativeTurnId === canonicalTurnId
          )) ?? null
        : store.getTurn(input.taskId, input.turnId);
      const existing = sessions.sessions[input.agentId];
      const owner = {
        scope: "task" as const,
        taskId: input.taskId,
        roleName: input.roleName
      };
      if (
        existing === undefined
        && !runtimeHookMatchesReservation(store, owner, input.runtimeGenerationId)
      ) {
        throw new Error("Runtime turn completion does not match the launch reservation.");
      }
      const effectiveExisting = nativeTransitionExisting(
        store,
        owner,
        existing,
        input.nativeSessionId,
        input.runtimeGenerationId,
        "Runtime turn completion conflicts with the fixed Role session."
      );
      const effective = taskSessionEffective(
        store,
        task.id,
        role.name,
        input.agentId,
        effectiveExisting
      );
      if (effective.agentId !== input.agentId || effective.adapterId !== input.adapterId) {
        throw new Error("Runtime turn completion does not match the effective runtime generation identity.");
      }
      if (effectiveExisting !== undefined
        && hasRecentTurnId(effectiveExisting.recentCompletedTurnIds, canonicalTurnId)) {
        return {
          session: effectiveExisting,
          duplicate: true,
          ...(observedTurn === null ? {} : { turn: observedTurn })
        };
      }
      if (!recordedProviderTurn
        && existing !== undefined
        && (
          hasRuntimeCleanupObligation(store.getWorkMailbox(runtimeLifecycleTarget(owner)))
          || isObsoleteTerminalRuntimeTurn(store, input)
        )) {
        return { session: existing, duplicate: false, disposition: "obsolete" };
      }
      if (!recordedProviderTurn && input.turnId !== undefined
        && observedTurn?.id !== input.turnId) {
        return { session: effectiveExisting!, duplicate: false, disposition: "obsolete" };
      }
      const sessionStatus = effectiveExisting?.status ?? "active";
      sessions = recordRoleAgentSession(sessions, {
        agentId: input.agentId,
        adapterId: input.adapterId,
        nativeSessionId: input.nativeSessionId,
        ...(input.runtimeGenerationId === undefined ? {} : { runtimeGenerationId: input.runtimeGenerationId }),
        policy: "fixed",
        status: sessionStatus,
        ...(effectiveExisting?.endReason === undefined
          ? {}
          : { endReason: effectiveExisting.endReason }),
        effective
      }, now);
      sessions = settleStructuredProviderTurn(
        sessions,
        canonicalTurnId,
        input.providerStatus,
        now
      );
      sessions = recordTaskRoleTurnBoundary(sessions, {
        agentId: input.agentId,
        nativeSessionId: input.nativeSessionId,
        turnId: canonicalTurnId
      }, now);
      store.saveTaskRoleSessionSet(sessions);
      completeRuntimeHookReservation(store, owner, input.runtimeGenerationId);
      let terminalTurn: Turn | undefined;
      if (recordedProviderTurn && observedTurn?.status === "active") {
        const binding = sessions.providerBinding!;
        const conversation = currentProviderConversation(binding);
        const activation = binding.activations.find((entry) => (
          entry.activationId === input.runtimeGenerationId
            || (entry.conversationId === conversation.conversationId && entry.status === "active")
        ));
        if (activation === undefined) {
          throw new Error("Provider Turn result has no matching Activation.");
        }
        const providerStatus = input.providerStatus;
        let systemEvidence: Parameters<typeof terminalizeExactTaskTurn>[1]["systemEvidence"];
        let workspaceFailure: Parameters<typeof terminalizeExactTaskTurn>[1]["workspaceFailure"];
        if ((observedTurn.purpose === "execution" || observedTurn.purpose === "review")
          && observedTurn.executionGroupId !== undefined
          && observedTurn.executionLaneId !== undefined
          && observedTurn.workspace !== undefined
          && input.outcome.status === "completed") {
          const gitSnapshot = this.snapshotExecutionLaneWorkspace(store, observedTurn.workspace);
          if (gitSnapshot.status === "captured") {
            systemEvidence = { workspaceSnapshot: gitSnapshot.snapshot };
          } else {
            workspaceFailure = {
              failureReason: gitSnapshot.cause === "workspace-dirty"
                ? "workspace-dirty"
                : gitSnapshot.cause === "branch-mismatch"
                  ? "workspace-branch-mismatch"
                  : "workspace-unavailable",
              diagnostic: gitSnapshot.diagnostic
            };
          }
        }
        const terminalized = terminalizeExactTaskTurn(store, {
          taskId: input.taskId,
          roleName: input.roleName,
          agentId: input.agentId,
          turnId: observedTurn.id,
          nativeSessionId: input.nativeSessionId,
          ...(input.runtimeGenerationId === undefined ? {} : { runtimeGenerationId: input.runtimeGenerationId }),
          outcome: {
            ...input.outcome,
            provider: {
              providerNamespace: binding.providerNamespace,
              accountScope: binding.accountScope,
              conversationId: conversation.conversationId,
              activationId: activation.activationId,
              nativeTurnId: canonicalTurnId,
              status: providerStatus
            }
          },
          ...(systemEvidence === undefined ? {} : { systemEvidence }),
          ...(workspaceFailure === undefined ? {} : { workspaceFailure })
        }, now);
        if (terminalized.disposition !== "applied" || terminalized.turn === null) {
          throw new Error(
            `Provider Turn terminal could not complete its exact Turn: ${
              terminalized.reason ?? "obsolete"
            }.`
          );
        }
        terminalTurn = terminalized.turn;
        const event = createTaskEvent(
          store.nextEventId(input.taskId),
          input.taskId,
          terminalTurn.status === "completed" ? "turn.completed" : "turn.failed",
          {
            turnId: terminalTurn.id,
            roleName: terminalTurn.roleName,
            providerTurnId: canonicalTurnId,
            providerStatus
          },
          now
        );
        store.saveEvent(input.taskId, event);
        if (terminalTurn.roleName !== "leader"
          && (terminalTurn.status !== "completed" || !providerGoalContinues(binding.goal))) {
          routeRoleEvent(
            store,
            event,
            terminalTurn.roleName,
            terminalTurn.purpose === "review" ? "review-result" : "role-turn-result",
            now
          );
        }
      }
      return {
        session: sessions.sessions[input.agentId]!,
        duplicate: false,
        ...(terminalTurn === undefined ? {} : { turn: terminalTurn })
      };
    });
  }

  saveRoleHostExitObservation(input: Readonly<{
    taskId: string;
    roleName: string;
    turnId: string;
    runtimeGenerationId?: string;
    nativeSessionId?: string;
    deadStatus?: number;
    observedAt: Date;
  }>): void {
    this.store.transaction((store) => {
      const identity = [
        input.taskId,
        input.roleName,
        input.turnId,
        input.runtimeGenerationId ?? "unknown-runtime-generation",
        String(input.deadStatus ?? "unknown-status")
      ].join("\0");
      const observationId = `tmux-host-exit-${createHash("sha256").update(identity).digest("hex")}`;
      const events = store.listEvents(input.taskId);
      if (events.some((event) => (
        event.type === "runtime.process-exit-observed"
        && event.payload.observationId === observationId
      ))) return;
      const stopReceipt = [...events].reverse().find((event) => (
        event.type === "runtime.session-termination"
        && event.payload.roleName === input.roleName
        && (input.runtimeGenerationId === undefined || event.payload.runtimeGenerationId === input.runtimeGenerationId)
        && ["stop-requested", "graceful-stop", "forced-stop", "stop-confirmed"]
          .includes(event.payload.outcome ?? "")
      ));
      const observation = validateRuntimeProcessExitObservation({
        schemaVersion: 2,
        observationId,
        hostSequence: 1,
        hostInstanceId: `tmux-${input.runtimeGenerationId ?? input.roleName}`,
        taskId: input.taskId,
        roleName: input.roleName,
        turnId: input.turnId,
        runtimeGenerationId: input.runtimeGenerationId ?? `unknown-${input.turnId}`,
        ...(input.nativeSessionId === undefined
          ? {}
          : { nativeSessionId: input.nativeSessionId }),
        processKind: "agent-host",
        ...(input.deadStatus === undefined ? {} : { exitCode: input.deadStatus }),
        ...(stopReceipt === undefined ? {} : { stopReceiptId: stopReceipt.id }),
        observedAt: input.observedAt.toISOString()
      });
      const classification = classifyRuntimeProcessExit(observation, {});
      store.saveEvent(input.taskId, createTaskEvent(
        store.nextEventId(input.taskId),
        input.taskId,
        "runtime.process-exit-observed",
        {
          observationId,
          processKind: "agent-host",
          roleName: input.roleName,
          runtimeGenerationId: observation.runtimeGenerationId,
          observedAt: observation.observedAt,
          classification,
          observation: JSON.stringify(observation)
        },
        input.observedAt
      ));
    });
  }

  /**
   * Issue 04: reopens each due retry on its original Native Session. A Turn
   * whose Session is proven dead terminalizes with an exact replacement
   * blocker; a live Session is reopened for the existing delivery path, which
   * re-pushes the exact same input in the same pass.
   */
  private observeProviderRuntimeIdentity(
    input: RuntimeObservation,
    now: Date
  ): ProviderLifecycleObservation {
    return this.store.transaction((store) => {
      const taskId = input.fence.taskId!;
      const sessions = store.getTaskRoleSessionSet(taskId, input.fence.roleName);
      if (sessions === null || sessions.providerBinding === null
        || input.fence.conversationId === undefined) {
        recordCanonicalObservationObsolete(store, input, "provider-binding-missing", now);
        return "obsolete";
      }
      let binding = sessions.providerBinding;
      if (input.fence.conversationId !== binding.conversations.find((entry) => (
        entry.epoch === binding.currentConversationEpoch
      ))?.conversationId) {
        recordCanonicalObservationObsolete(store, input, "provider-conversation-mismatch", now);
        return "obsolete";
      }
      try {
        if (input.kind === "conversation.observed") {
          binding = updateProviderConversationRecoverability(
            binding,
            input.payload.recoverability!
          );
        } else if (input.kind === "activation.started") {
          const active = binding.activations.find((entry) => entry.status === "active");
          if (active?.activationId !== input.fence.activationId) {
            binding = startProviderActivation(binding, {
              activationId: input.fence.activationId!,
              startedAt: input.observedAt ?? input.receivedAt
            });
          }
        } else {
          binding = endProviderActivation(binding, input.fence.activationId!, {
            status: input.kind === "activation.failed" ? "failed" : "ended",
            endedAt: input.observedAt ?? input.receivedAt,
            reason: input.kind
          });
        }
      } catch {
        recordCanonicalObservationObsolete(store, input, "provider-identity-conflict", now);
        return "obsolete";
      }
      store.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(sessions, binding, now));
      return "applied";
    });
  }

  private observeProviderGoal(
    input: RuntimeObservation,
    now: Date
  ): ProviderLifecycleObservation {
    return this.store.transaction((store) => {
      const taskId = input.fence.taskId!;
      const sessions = store.getTaskRoleSessionSet(taskId, input.fence.roleName);
      const binding = sessions?.providerBinding;
      if (sessions === null || sessions === undefined || binding === null || binding === undefined
        || input.fence.conversationId !== currentProviderConversation(binding).conversationId) {
        recordCanonicalObservationObsolete(store, input, "provider-goal-session-mismatch", now);
        return "obsolete";
      }
      const updated = input.kind === "goal.cleared"
        ? clearProviderGoal(binding)
        : updateProviderGoal(binding, {
            status: input.payload.goalStatus!,
            objective: input.payload.goalObjective!,
            updatedAt: input.payload.goalUpdatedAt!,
            ...(input.payload.goalNativeTurnId === undefined
              ? {}
              : { nativeTurnId: input.payload.goalNativeTurnId }),
            ...(input.payload.goalTokenBudget === undefined
              ? {}
              : { tokenBudget: input.payload.goalTokenBudget })
          });
      store.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(sessions, updated, now));
      return "applied";
    });
  }

  private observeRuntimeSession(
    input: RuntimeObservation,
    adapterId: string,
    now: Date
  ): ProviderLifecycleObservation {
    return this.store.transaction((store) => {
      const event = createCanonicalLifecycleEvent({
        phase: input.kind === "session.ready" ? "provider-ready" : "provider-session-started",
        source: "provider-native",
        evidence: "provider-native-durable",
        ...(input.kind === "session.ready"
          ? {
              preInputReady: true,
              readinessVariant: `${input.fence.driverId}:session.ready`
            }
          : {}),
        fence: runtimeObservationLifecycleFence(input, adapterId)
      });
      const decision = this.foldRuntimeLifecycleEvent(store, event, input);
      switch (decision.kind) {
        case "obsolete":
          recordCanonicalObservationObsolete(store, input, decision.reason, now);
          return "obsolete";
        case "deferred":
          return "deferred";
        case "idempotent":
          return "applied";
        case "apply": {
          if (decision.outcome.outcome === "mark-ready"
            && store.getTaskRoleSessionSet(input.fence.taskId!, input.fence.roleName)
              ?.sessions[input.fence.agentId] === undefined) {
            return preallocatedRuntimeReadyAwaitingProjection(store, input, this.drivers)
              ? "applied"
              : "deferred";
          }
          if (decision.outcome.outcome === "bind-native-session") {
            const taskId = input.fence.taskId!;
            const role = store.getRole(taskId, input.fence.roleName);
            const sessions = store.getTaskRoleSessionSet(taskId, input.fence.roleName);
            const run = store.getTurn(taskId, input.fence.turnId!);
            if (role === null || sessions === null || run === null) {
              recordCanonicalObservationObsolete(store, input, "bind-state-missing", now);
              return "obsolete";
            }
            const mailbox = store.getWorkMailbox({
              kind: "role",
              taskId,
              roleName: input.fence.roleName
            });
            const existingSession = sessions.sessions[input.fence.agentId];
            const existingNativeSessionId = existingSession?.nativeSessionId;
            const replacingNativeSession = existingNativeSessionId !== undefined
              && existingNativeSessionId !== decision.outcome.nativeSessionId;
            const replacementBasis = terminalSessionReplacementBasis(
              sessions,
              input,
              run
            ) ?? null;
            if (replacingNativeSession && replacementBasis === null) {
              recordCanonicalObservationObsolete(
                store,
                input,
                "session-replacement-not-terminal",
                now
              );
              return "obsolete";
            }
            const sessionInput = {
              agentId: input.fence.agentId,
              adapterId,
              nativeSessionId: decision.outcome.nativeSessionId,
              runtimeGenerationId: input.fence.runtimeGenerationId,
              policy: "fixed" as const,
              status: "active" as const,
              effective: run.effective
            };
            const bound = replacementBasis === null
              ? recordRoleAgentSession(sessions, sessionInput, now)
              : replaceTaskRoleAgentSession(
                  sessions,
                  sessionInput,
                  now
                );
            const withProvider = bindOrSupersedeProviderRuntime(
              bound,
              input,
              now,
              replacementBasis
                ?? terminalProviderReplacementBasis(bound, input, run.mode)
            );
            store.saveTaskRoleSessionSet(withProvider);
            completeRuntimeHookReservation(
              store,
              { scope: "task", taskId, roleName: input.fence.roleName },
              input.fence.runtimeGenerationId
            );
          }
          const current = store.getTaskRoleSessionSet(
            input.fence.taskId!,
            input.fence.roleName
          );
          const currentSession = current?.sessions[input.fence.agentId];
          if (current !== null && current !== undefined
            && currentSession?.nativeSessionId === input.fence.nativeSessionId) {
            const run = input.fence.turnId === undefined
              ? null
              : store.getTurn(input.fence.taskId!, input.fence.turnId);
            const replacementBasis = run === null
              ? undefined
              : terminalSessionReplacementBasis(current, input, run)
                ?? terminalProviderReplacementBasis(current, input, run.mode);
            if (current.providerBinding !== null
              && currentProviderConversation(current.providerBinding).conversationId
                !== (input.fence.conversationId ?? input.fence.nativeSessionId)
              && replacementBasis === undefined) {
              recordCanonicalObservationObsolete(
                store,
                input,
                "session-replacement-not-terminal",
                now
              );
              return "obsolete";
            }
            store.saveTaskRoleSessionSet(bindOrSupersedeProviderRuntime(
              current,
              input,
              now,
              replacementBasis
            ));
          }
          return "applied";
        }
      }
    });
  }

  /** Provider acceptance is canonical before storage and remains receipt-fenced. */
  private observeRuntimePromptAccepted(
    input: RuntimeObservation,
    adapterId: string,
    now: Date
  ): ProviderLifecycleObservation {
    return this.store.transaction((store) => {
      const continuation = input.fence.receiptId?.startsWith("turn-input:") === true;
      const ordinaryAttemptId = input.fence.receiptId;
      if (input.fence.turnId === undefined
        && ordinaryAttemptId?.startsWith("direct:") === true) {
        const taskId = input.fence.taskId!;
        const sessions = store.getTaskRoleSessionSet(taskId, input.fence.roleName);
        const session = sessions?.sessions[input.fence.agentId];
        const binding = sessions?.providerBinding;
        const nativeTurnId = input.fence.nativeTurnId!;
        const active = store.getActiveTurn(taskId, input.fence.roleName);
        if (sessions === null || sessions === undefined
          || binding === null || binding === undefined
          || session?.runtimeGenerationId !== input.fence.runtimeGenerationId
          || session.nativeSessionId !== input.fence.nativeSessionId
          || currentProviderConversation(binding).conversationId !== input.fence.nativeSessionId) {
          recordCanonicalObservationObsolete(store, input, "direct-turn-session-mismatch", now);
          return "obsolete";
        }
        if (binding.turn?.attemptId === ordinaryAttemptId
          && binding.turn.nativeTurnId === nativeTurnId
          && binding.turn.turnId !== undefined
          && active?.id === binding.turn.turnId) {
          return "applied";
        }
        if (active !== null) {
          recordCanonicalObservationObsolete(store, input, "direct-turn-conflicts-with-active-turn", now);
          return "obsolete";
        }
        const turnId = store.nextTurnId(taskId);
        const goalContinuation = input.payload.input === undefined
          && providerGoalContinues(binding.goal);
        const direct = createTurn(
          turnId,
          taskId,
          input.fence.roleName,
          "resume",
          createTurnInput({
            source: goalContinuation
              ? { type: "provider", channel: "goal-continuation" }
              : { type: "user", channel: "direct" },
            ...(input.payload.input === undefined
              ? {}
              : { directive: input.payload.input }),
            deltaRefIds: []
          }),
          now,
          { effective: session.effective }
        );
        const submittedAt = input.observedAt ?? input.receivedAt;
        const accepted = acceptProviderTurn(beginProviderTurn(binding, {
          turnId,
          attemptId: ordinaryAttemptId,
          authorityEpoch: binding.authority.epoch,
          submittedAt
        }), {
          attemptId: ordinaryAttemptId,
          nativeTurnId,
          acceptedAt: submittedAt
        });
        store.saveTurn(direct);
        store.saveActiveTurn(direct);
        store.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(sessions, accepted, now));
        store.saveEvent(taskId, createTaskEvent(
          store.nextEventId(taskId),
          taskId,
          "turn.dispatched",
          turnLaunchEventPayload(direct),
          now
        ));
        return "applied";
      }
      if (ordinaryAttemptId !== undefined) {
        const sessions = store.getTaskRoleSessionSet(
          input.fence.taskId!,
          input.fence.roleName
        );
        const session = sessions?.sessions[input.fence.agentId];
        const binding = sessions?.providerBinding;
        if (sessions !== null && sessions !== undefined
          && binding !== null && binding !== undefined
          && binding.turn?.turnId === undefined
          && binding.turn?.attemptId === ordinaryAttemptId) {
          if (session?.runtimeGenerationId !== input.fence.runtimeGenerationId
            || session.nativeSessionId !== input.fence.nativeSessionId) {
            recordCanonicalObservationObsolete(store, input, "ordinary-turn-session-mismatch", now);
            return "obsolete";
          }
          store.saveTaskRoleSessionSet(recordStructuredProviderAcceptance(
            sessions,
            input,
            now
          ));
          return "applied";
        }
      }
      if (continuation) {
        const active = store.getActiveTurn(input.fence.taskId!, input.fence.roleName);
        const sessions = store.getTaskRoleSessionSet(
          input.fence.taskId!,
          input.fence.roleName
        );
        const session = sessions?.sessions[input.fence.agentId];
        if (active === null
          || active.id !== input.fence.turnId
          || active.status !== "active"
          || sessions === null
          || sessions === undefined
          || session?.runtimeGenerationId !== input.fence.runtimeGenerationId
          || session.nativeSessionId !== input.fence.nativeSessionId) {
          recordCanonicalObservationObsolete(store, input, "continuation-fence-mismatch", now);
          return "obsolete";
        }
        store.saveTaskRoleSessionSet(recordStructuredProviderAcceptance(
          sessions,
          input,
          now
        ));
        store.saveEvent(input.fence.taskId!, createTaskEvent(
          store.nextEventId(input.fence.taskId!),
          input.fence.taskId!,
          "turn.input-delivered",
          {
            attemptId: input.fence.receiptId!,
            turnId: active.id,
            conversationId: input.fence.conversationId ?? input.fence.nativeSessionId!,
            activationId: input.fence.activationId ?? input.fence.runtimeGenerationId,
            ...(input.fence.nativeTurnId === undefined
              ? {}
              : { nativeTurnId: input.fence.nativeTurnId })
          },
          now
        ));
        return "applied";
      }
      const event = createCanonicalLifecycleEvent({
        phase: "provider-accepted",
        source: "provider-native",
        evidence: "provider-native-durable",
        fence: runtimeObservationLifecycleFence(input, adapterId)
      });
      const decision = this.foldRuntimeLifecycleEvent(store, event, input);
      if (decision.kind === "obsolete") {
        recordCanonicalObservationObsolete(store, input, decision.reason, now);
        return "obsolete";
      }
      if (decision.kind === "deferred") return "deferred";
      if (decision.kind === "idempotent") return "applied";
      const active = store.getActiveTurn(input.fence.taskId!, input.fence.roleName);
      if (active === null
        || active.id !== input.fence.turnId
        || active.status !== "active") {
        recordCanonicalObservationObsolete(store, input, "turn-not-active", now);
        return "obsolete";
      }
      const sessions = store.getTaskRoleSessionSet(
        input.fence.taskId!,
        input.fence.roleName
      );
      if (sessions !== null) {
        store.saveTaskRoleSessionSet(recordStructuredProviderAcceptance(
          sessions,
          input,
          now
        ));
      }
      return "applied";
    });
  }

  private foldRuntimeLifecycleEvent(
    store: TaskStore,
    event: ReturnType<typeof createCanonicalLifecycleEvent>,
    observation: RuntimeObservation
  ): Readonly<
    | { kind: "apply"; outcome: ReturnType<typeof foldCanonicalLifecycleEvent> }
    | { kind: "idempotent"; reason: string }
    | { kind: "deferred"; reason: string }
    | { kind: "obsolete"; reason: string }
  > {
    const expectation = this.projectTurnExpectation(
      store,
      event.fence,
      observation.fence.turnId
    );
    if (expectation === null) {
      return preallocatedRuntimeReadyAwaitingProjection(
        store,
        observation,
        this.drivers
      )
        ? { kind: "apply", outcome: { outcome: "mark-ready", preInputReady: true } }
        : { kind: "obsolete", reason: "turn-or-role-missing" };
    }
    const outcome = foldCanonicalLifecycleEvent(event, expectation);
    switch (outcome.outcome) {
      case "obsolete":
        return { kind: "obsolete", reason: outcome.reason };
      case "fail-closed":
        return { kind: "obsolete", reason: `fail-closed:${outcome.reason}` };
      case "deferred":
        return { kind: "deferred", reason: outcome.reason };
      case "idempotent":
        return { kind: "idempotent", reason: outcome.reason };
      default:
        return { kind: "apply", outcome };
    }
  }

  /** Reads durable Turn + Session state into the pure fold's expectation shape. */
  private projectTurnExpectation(
    store: TaskStore,
    fence: CanonicalIdentityFence,
    turnId: string | undefined
  ): CanonicalTurnExpectation | null {
    const role = store.getRole(fence.taskId, fence.roleName);
    if (role === null) return null;
    const sessionSet = store.getTaskRoleSessionSet(fence.taskId, fence.roleName);
    const session = sessionSet?.sessions[fence.agentId] ?? null;
    if (turnId === undefined) {
      return {
        fence,
        sessionStarted: false,
        ready: false,
        pushed: false,
        accepted: false,
        terminal: false,
        ...(session?.nativeSessionId === undefined
          ? {}
          : { boundNativeSessionId: session.nativeSessionId })
      };
    }
    const run = store.getTurn(fence.taskId, turnId);
    if (run === null || run.status !== "active") return null;
    const owner = { scope: "task" as const, taskId: fence.taskId, roleName: fence.roleName };
    const freshConversationLaunch = run.mode === "new"
      && runtimeHookMatchesReservation(store, owner, fence.runtimeGenerationId);
    const boundNativeSessionId = freshConversationLaunch
      ? undefined
      : session?.nativeSessionId;
    const runtimeGenerationId = freshConversationLaunch
      ? fence.runtimeGenerationId
      : session?.runtimeGenerationId
        ?? (runtimeHookMatchesReservation(store, owner, fence.runtimeGenerationId) ? fence.runtimeGenerationId : undefined);
    if (runtimeGenerationId === undefined) return null;
    const providerTurn = sessionSet?.providerBinding?.turn;
    const managedTurnMatches = managedProviderTurnId(providerTurn) === run.id;
    const expectedFence: CanonicalIdentityFence = {
      taskId: fence.taskId,
      roleName: fence.roleName,
      agentId: run.effective.agentId,
      adapterId: run.effective.adapterId,
      turnId: run.id,
      runtimeGenerationId,
      receiptId: managedTurnMatches && providerTurn !== null && providerTurn !== undefined
        ? providerTurn.attemptId
        : formatTurnReceiptId(run.taskId, run.id),
      ...(boundNativeSessionId === undefined ? {} : { nativeSessionId: boundNativeSessionId })
    };
    const driverId = this.drivers.requireByAdapterId(run.effective.adapterId).id;
    const lifecycleEvents = store.listEvents(fence.taskId).flatMap((event) => {
      const observation = runtimeObservationFromTaskEvent(event);
      return observation !== null
        && (observation.kind === "session.started" || observation.kind === "session.ready")
        && observation.fence.roleName === fence.roleName
        && observation.fence.agentId === run.effective.agentId
        && observation.fence.driverId === driverId
        && observation.fence.runtimeGenerationId === runtimeGenerationId
        && observation.fence.nativeSessionId === (boundNativeSessionId ?? fence.nativeSessionId)
        ? [observation]
        : [];
    });
    return {
      fence: expectedFence,
      sessionStarted: lifecycleEvents.length > 0,
      ready: lifecycleEvents.some((event) => event.kind === "session.ready"),
      pushed: managedTurnMatches,
      accepted: managedTurnMatches && providerTurn !== null && providerTurn !== undefined
        && ["accepted", "completed", "failed", "cancelled"]
          .includes(providerTurn.status),
      terminal: run.status !== "active",
      ...(boundNativeSessionId === undefined ? {} : { boundNativeSessionId })
    };
  }

  observeObsoleteRuntimeEvent(input: Readonly<{
    eventId: string;
    eventType: string;
    taskId: string;
    roleName: string;
    agentId: string;
    turnId?: string;
    runtimeGenerationId?: string;
    nativeSessionId: string;
    reason: string;
  }>, now = new Date()): void {
    this.store.transaction((store) => {
      if (store.getTask(input.taskId) === null) return;
      recordObsoleteRuntimeEvent(store, input, input.reason, now);
    });
  }

  recordGlobalRuntimeNativeSession(input: Readonly<{
    roleName: string;
    agentId: string;
    adapterId: string;
    runtimeGenerationId?: string;
    nativeSessionId: string;
  }>, now = new Date()): RoleAgentSession {
    return this.store.transaction((store) => (
      recordGlobalRuntimeNativeSession(store, input, now)
    ));
  }

  observeGlobalRuntimeTurnTerminal(input: Readonly<{
    roleName: string;
    agentId: string;
    adapterId: string;
    runtimeGenerationId?: string;
    nativeSessionId: string;
    nativeTurnId: string;
    title?: string;
    providerStatus: "completed" | "failed" | "cancelled";
    outcome: RuntimeTurnTerminalOutcome;
  }>, now = new Date()): RoleAgentSession {
    return this.store.transaction((store) => {
      const role = store.getGlobalRole(input.roleName);
      if (role === null) throw new Error(`Global Role not found: ${input.roleName}.`);
      let current: GlobalRoleSessionSet = store.getGlobalRoleSessionSet(input.roleName)
        ?? createRoleSessionSet(
          { scope: "global", roleName: input.roleName },
          input.agentId,
          now
        );
      const existing = current.sessions[input.agentId];
      const owner = {
        scope: "global" as const,
        roleName: input.roleName
      };
      if (
        existing === undefined
        && !runtimeHookMatchesReservation(store, owner, input.runtimeGenerationId)
      ) {
        throw new Error(
          "Runtime turn completion does not match the global launch reservation."
        );
      }
      const nativeSessionId = globalCompletionNativeSessionId(existing, input);
      const effectiveExisting = nativeTransitionExisting(
        store,
        owner,
        existing,
        nativeSessionId,
        input.runtimeGenerationId,
        "Runtime turn completion conflicts with the fixed global Role session."
      );
      const effective = globalSessionEffective(role, effectiveExisting);
      if (effective.agentId !== input.agentId || effective.adapterId !== input.adapterId) {
        throw new Error("Runtime turn completion does not match the effective global runtime generation identity.");
      }
      const completedStatus = effectiveExisting?.status ?? "active";
      current = recordRoleAgentSession(current, {
        agentId: input.agentId,
        adapterId: input.adapterId,
        nativeSessionId,
        ...(input.runtimeGenerationId === undefined ? {} : { runtimeGenerationId: input.runtimeGenerationId }),
        title: effectiveExisting?.title ?? input.title,
        preview: effectiveExisting?.preview ?? sessionPreview(
          input.outcome.status === "completed"
            ? input.outcome.output
            : input.outcome.diagnostic
        ),
        policy: "fixed",
        status: completedStatus,
        ...(effectiveExisting?.endReason === undefined
          ? {}
          : { endReason: effectiveExisting.endReason }),
        effective
      }, now);
      current = rememberRoleAgentCompletedTurn(
        current,
        input.agentId,
        nativeSessionId,
        input.nativeTurnId,
        now
      );
      store.saveGlobalRoleSessionSet(current);
      completeRuntimeHookReservation(store, owner, input.runtimeGenerationId);
      if (
        input.roleName === SYSTEM_OPERATOR_ROLE
        && input.adapterId === "codex"
        && completedStatus === "active"
      ) {
        const operatorMailbox = store.getWorkMailbox({ kind: "operator" });
        // A completed foreground Codex Turn leaves its native TUI attached to
        // the thread. Stop only that idle Role runtime so Desktop can become
        // the writer; the durable nativeSessionId remains available to resume.
        if (operatorMailbox === null || !mailboxHasWork(operatorMailbox)) {
          enqueueWork(
            store,
            runtimeLifecycleTarget(owner),
            RUNTIME_HOST_DETACH_REQUIRED_REASON,
            now
          );
        }
      }
      return current.sessions[input.agentId]!;
    });
  }

  classifyGlobalRuntimeTurnTerminal(input: Readonly<{
    roleName: string;
    agentId: string;
    adapterId: string;
    runtimeGenerationId?: string;
    nativeSessionId: string;
    providerStatus: "completed" | "failed" | "cancelled";
    outcome: RuntimeTurnTerminalOutcome;
  }>): "apply" | "obsolete" {
    const role = this.store.getGlobalRole(input.roleName);
    if (role === null) return "obsolete";
    const existing = this.store.getGlobalRoleSessionSet(input.roleName)
      ?.sessions[input.agentId];
    const owner = {
      scope: "global" as const,
      roleName: input.roleName
    };
    if (
      existing === undefined
      && !runtimeHookMatchesReservation(this.store, owner, input.runtimeGenerationId)
    ) return "obsolete";
    const nativeSessionId = globalCompletionNativeSessionId(existing, input);
    let effectiveExisting: RoleAgentSession | undefined;
    try {
      effectiveExisting = nativeTransitionExisting(
        this.store,
        owner,
        existing,
        nativeSessionId,
        input.runtimeGenerationId,
        "Runtime turn completion conflicts with the fixed global Role session."
      );
    } catch {
      return "obsolete";
    }
    const effective = globalSessionEffective(role, effectiveExisting);
    if (effective.agentId !== input.agentId || effective.adapterId !== input.adapterId) {
      return "obsolete";
    }
    return "apply";
  }
}

function runtimeObservationLifecycleFence(
  input: RuntimeObservation,
  adapterId: string
): CanonicalIdentityFence {
  return {
    taskId: input.fence.taskId!,
    roleName: input.fence.roleName,
    agentId: input.fence.agentId,
    adapterId,
    runtimeGenerationId: input.fence.runtimeGenerationId,
    ...(input.fence.turnId === undefined ? {} : { turnId: input.fence.turnId }),
    ...(input.fence.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: input.fence.nativeSessionId }),
    ...(input.fence.receiptId === undefined ? {} : { receiptId: input.fence.receiptId })
  };
}

/**
 * A live parent Turn still owns its native child result. Only after that Turn
 * is terminal or absent does Yui route the continuation fact to the original
 * Role's supervisor. Mailbox coalescing remains the downstream batching
 * mechanism; this guard decides ownership before any wake is enqueued.
 */
function routeContinuationResult(
  store: TaskStore,
  observation: RuntimeObservation,
  event: TaskEvent,
  reason: string,
  now: Date
): void {
  const taskId = observation.fence.taskId;
  if (taskId === undefined) return;
  const parentTurn = observation.fence.turnId === undefined
    ? null
    : store.getTurn(taskId, observation.fence.turnId);
  if (parentTurn?.status === "active") return;
  if (store.getRole(taskId, observation.fence.roleName) === null) return;
  routeRoleEvent(
    store,
    event,
    observation.fence.roleName,
    reason,
    now
  );
}

/** Accepts the original Turn receipt or a later mailbox activation receipt. */
function runtimeReceiptBelongsToTurn(
  store: TaskStore,
  input: RuntimeObservation
): boolean {
  const taskId = input.fence.taskId!;
  const turnId = input.fence.turnId!;
  const receiptId = input.fence.receiptId;
  if (receiptId === formatTurnReceiptId(taskId, turnId)) return true;
  if (receiptId === undefined) return false;
  return store.listEvents(taskId).some((event) => {
    const accepted = runtimeObservationFromTaskEvent(event);
    return accepted?.kind === "turn.accepted"
      && accepted.fence.turnId === turnId
      && accepted.fence.roleName === input.fence.roleName
      && accepted.fence.agentId === input.fence.agentId
      && accepted.fence.runtimeGenerationId === input.fence.runtimeGenerationId
      && accepted.fence.nativeSessionId === input.fence.nativeSessionId
      && accepted.fence.receiptId === receiptId;
  });
}

function recordCanonicalObservationObsolete(
  store: TaskStore,
  input: RuntimeObservation,
  reason: string,
  now: Date
): void {
  const taskId = input.fence.taskId;
  if (taskId === undefined) return;
  recordObsoleteRuntimeEvent(store, {
    eventId: input.eventId,
    dedupeKey: input.semanticKey,
    eventType: input.kind,
    taskId,
    roleName: input.fence.roleName,
    agentId: input.fence.agentId,
    ...(input.fence.turnId === undefined ? {} : { turnId: input.fence.turnId }),
    runtimeGenerationId: input.fence.runtimeGenerationId,
    nativeSessionId: input.fence.nativeSessionId ?? input.fence.runtimeGenerationId
  }, reason, now);
}

function recordObsoleteRuntimeEvent(
  store: TaskStore,
  input: Readonly<{
    eventId: string;
    dedupeKey?: string;
    eventType?: string;
    type?: string;
    taskId: string;
    roleName: string;
    agentId: string;
    turnId?: string;
    runtimeGenerationId?: string;
    nativeSessionId: string;
  }>,
  reason: string,
  now: Date
): void {
  if (store.listEvents(input.taskId).some((event) => (
    event.type === "runtime.event-obsolete"
    && (event.payload.dedupeKey ?? event.payload.eventId) === (input.dedupeKey ?? input.eventId)
  ))) return;
  store.saveEvent(input.taskId, createTaskEvent(
    store.nextEventId(input.taskId),
    input.taskId,
    "runtime.event-obsolete",
    {
      eventId: input.eventId,
      ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
      eventType: input.eventType ?? input.type ?? "unknown",
      roleName: input.roleName,
      agentId: input.agentId,
      nativeSessionId: input.nativeSessionId,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.runtimeGenerationId === undefined ? {} : { runtimeGenerationId: input.runtimeGenerationId }),
      reason
    },
    now
  ));
}

function isLeaderDisposedWorkItemTurn(
  store: TaskStore,
  input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    turnId?: string;
  }>
): boolean {
  if (input.turnId === undefined) return false;
  const run = store.getTurn(input.taskId, input.turnId);
  if (run === null
    || run.status !== "failed"
    || run.roleName !== input.roleName
    || run.effective.agentId !== input.agentId
    || run.workItemId === undefined) {
    return false;
  }
  return store.getWorkItem(input.taskId, run.workItemId)?.disposition !== undefined;
}

function isObsoleteTerminalRuntimeTurn(
  store: TaskStore,
  input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    turnId?: string;
  }>
): boolean {
  if (isLeaderDisposedWorkItemTurn(store, input)) return true;
  if (input.turnId === undefined) return false;
  const run = store.getTurn(input.taskId, input.turnId);
  if (
    run === null
    || run.status !== "failed"
    || run.roleName !== input.roleName
    || run.effective.agentId !== input.agentId
  ) {
    return false;
  }
  return store.listEvents(input.taskId).some((event) => (
    event.type === "runtime.role-delivery-failed"
    && event.payload.turnId === input.turnId
  ));
}

function sessionPreview(value: string): string {
  const normalized = value.trim().replaceAll(/\s+/g, " ");
  const truncated = normalized.slice(0, 1_024);
  return /[\uD800-\uDBFF]$/.test(truncated)
    ? truncated.slice(0, -1)
    : truncated;
}

function requireRuntimeLaunchReservation(
  store: TaskStore,
  owner: RuntimeRoleOwner,
  runtimeGenerationId: string
) {
  const mailbox = store.getWorkMailbox(runtimeLifecycleTarget(owner));
  if (!isRuntimeLaunchReservation(mailbox?.processing, runtimeGenerationId)) {
    throw new Error("Runtime launch reservation no longer matches the launch.");
  }
  return mailbox!;
}

function runtimeHookMatchesReservation(
  store: TaskStore,
  owner: RuntimeRoleOwner,
  runtimeGenerationId: string | undefined
): boolean {
  const mailbox = store.getWorkMailbox(runtimeLifecycleTarget(owner));
  if (hasRuntimeCleanupObligation(mailbox)) return false;
  const processing = mailbox?.processing;
  return runtimeGenerationId !== undefined
    && isRuntimeLaunchReservation(processing, runtimeGenerationId);
}

function preallocatedRuntimeReadyAwaitingProjection(
  store: TaskStore,
  observation: RuntimeObservation,
  drivers: AgentDriverRegistry
): boolean {
  const taskId = observation.fence.taskId;
  const turnId = observation.fence.turnId;
  const nativeSessionId = observation.fence.nativeSessionId;
  const driver = drivers.find(observation.fence.driverId);
  if (observation.kind !== "session.ready"
    || driver?.capabilities.observation.sessionBootstrap !== "preallocated"
    || taskId === undefined
    || turnId === undefined
    || nativeSessionId === undefined) return false;

  const task = store.getTask(taskId);
  const role = store.getRole(taskId, observation.fence.roleName);
  const run = store.getActiveTurn(taskId, observation.fence.roleName);
  const sessions = store.getTaskRoleSessionSet(taskId, observation.fence.roleName);
  if (task?.status !== "active"
    || task.executionGate.state !== "enabled"
    || role?.activeAgentId !== observation.fence.agentId
    || run?.id !== turnId
    || run.status !== "active"
    || run.effective.agentId !== observation.fence.agentId
    || run.effective.adapterId !== driver.adapterId
    || observation.fence.receiptId !== formatTurnReceiptId(run.taskId, run.id)
    || sessions?.sessions[observation.fence.agentId] !== undefined) return false;

  const mailbox = store.getWorkMailbox(runtimeLifecycleTarget({
    scope: "task",
    taskId,
    roleName: observation.fence.roleName
  }));
  return isRuntimeLaunchReservation(mailbox?.processing, observation.fence.runtimeGenerationId)
    && !hasRuntimeCleanupObligation(mailbox)
    && nativeSessionId === nativeSessionIdForLaunch(
      store.rootDirectory(),
      observation.fence.runtimeGenerationId,
      observation.fence.agentId,
      driver.adapterId
    );
}

function completeRuntimeHookReservation(
  store: TaskStore,
  owner: RuntimeRoleOwner,
  runtimeGenerationId: string | undefined
): void {
  if (runtimeGenerationId === undefined) return;
  const mailbox = store.getWorkMailbox(runtimeLifecycleTarget(owner));
  if (!isRuntimeLaunchReservation(mailbox?.processing, runtimeGenerationId)) return;
  saveRuntimeLifecycleMailbox(
    store,
    completeProcessing(mailbox!, runtimeGenerationId)
  );
}

function saveRuntimeLifecycleMailbox(
  store: TaskStore,
  mailbox: WorkMailbox
): void {
  if (!mailboxHasWork(mailbox)) {
    store.removeWorkMailbox(mailbox.target);
    return;
  }
  store.saveWorkMailbox(mailbox);
}

function runtimeOwnerFromTarget(
  target: RuntimeLifecycleTarget
): RuntimeRoleOwner {
  return target.kind === "role-runtime"
    ? {
        scope: "task",
        taskId: target.taskId,
        roleName: target.roleName
      }
    : {
        scope: "global",
        roleName: target.roleName
      };
}

function sameRuntimeOwner(
  left: RuntimeRoleOwner,
  right: RuntimeRoleOwner
): boolean {
  return left.scope === "task"
    ? right.scope === "task"
      && left.taskId === right.taskId
      && left.roleName === right.roleName
    : right.scope === "global" && left.roleName === right.roleName;
}

function dormantRuntimeCandidateIsCurrent(
  store: TaskStore,
  candidate: DormantRuntimeOwnerCandidate
): boolean {
  const { owner } = candidate;
  if (hasRuntimeLifecycleWork(
    store.getWorkMailbox(runtimeLifecycleTarget(owner))
  )) {
    return false;
  }
  if (
    owner.scope === "task"
    && store.getActiveTurn(owner.taskId, owner.roleName) !== null
  ) {
    return false;
  }
  const sessions = runtimeOwnerSessionSet(store, owner);
  const active = sessions?.sessions[sessions.activeAgentId];
  return active !== undefined
    && active.status === "active"
    && active.agentId === candidate.agentId
    && active.adapterId === candidate.adapterId
    && active.nativeSessionId === candidate.nativeSessionId
    && active.runtimeGenerationId === candidate.runtimeGenerationId
    && active.updatedAt === candidate.sessionUpdatedAt;
}

function endRuntimeOwnerSession(
  store: TaskStore,
  owner: RuntimeRoleOwner,
  now: Date
): boolean {
  if (owner.scope === "task") {
    const sessions = store.getTaskRoleSessionSet(
      owner.taskId,
      owner.roleName
    );
    if (sessions === null) return false;
    const active = sessions.sessions[sessions.activeAgentId];
    if (active === undefined) return false;
    let stopped = active.status === "ended"
      ? sessions
      : updateRoleAgentSessionStatus(
          sessions,
          sessions.activeAgentId,
          "ended",
          now,
          "stopped"
        );
    const activation = stopped.providerBinding === null
      ? null
      : currentProviderActivation(stopped.providerBinding);
    if (activation !== null) {
      stopped = updateTaskRoleProviderRuntime(
        stopped,
        endProviderActivation(stopped.providerBinding!, activation.activationId, {
          status: "ended",
          endedAt: now.toISOString(),
          reason: "session-ended"
        }),
        now
      );
    }
    if (stopped === sessions) return false;
    store.saveTaskRoleSessionSet(stopped);
    return true;
  }
  const sessions = store.getGlobalRoleSessionSet(owner.roleName);
  if (sessions === null) return false;
  const active = sessions.sessions[sessions.activeAgentId];
  if (active === undefined || active.status === "ended") return false;
  store.saveGlobalRoleSessionSet(updateRoleAgentSessionStatus(
    sessions,
    sessions.activeAgentId,
    "ended",
    now,
    "stopped"
  ));
  return true;
}

function detachRuntimeOwnerHost(
  store: TaskStore,
  owner: RuntimeRoleOwner,
  now: Date
): boolean {
  if (owner.scope === "task") {
    const sessions = store.getTaskRoleSessionSet(owner.taskId, owner.roleName);
    if (sessions === null) return false;
    const detached = detachRoleAgentSessionHost(sessions, now);
    if (detached === sessions) return false;
    store.saveTaskRoleSessionSet(detached);
    return true;
  }
  const sessions = store.getGlobalRoleSessionSet(owner.roleName);
  if (sessions === null) return false;
  const detached = detachRoleAgentSessionHost(sessions, now);
  if (detached === sessions) return false;
  store.saveGlobalRoleSessionSet(detached);
  return true;
}

function runtimeOwnerSessionSet(
  store: TaskStore,
  owner: RuntimeRoleOwner
): TaskRoleSessionSet | GlobalRoleSessionSet | null {
  return owner.scope === "task"
    ? store.getTaskRoleSessionSet(owner.taskId, owner.roleName)
    : store.getGlobalRoleSessionSet(owner.roleName);
}

function runtimeSessionMatchesSettledLaunch(
  session: RoleAgentSession | undefined,
  input: Readonly<{
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
  }>
): session is RoleAgentSession {
  return session !== undefined
    && session.agentId === input.agentId
    && session.adapterId === input.adapterId
    && (
      input.nativeSessionId === undefined
      || session.nativeSessionId === input.nativeSessionId
    );
}

function recordTaskRuntimeNativeSession(
  store: TaskStore,
  input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    runtimeGenerationId?: string;
    nativeSessionId: string;
    effective?: EffectiveLaunchSnapshot;
  }>,
  now: Date
): RoleAgentSession {
  const task = store.getTask(input.taskId);
  if (task === null) throw new Error(`Task not found: ${input.taskId}.`);
  if (task.status === "archived") {
    throw new Error(`Cannot register a native session for archived Task: ${input.taskId}.`);
  }
  if (task.status !== "active" || task.executionGate.state !== "enabled") {
    throw new Error(
      `Cannot register a native session for a Task that is not active: ${input.taskId}.`
    );
  }
  const role = requireRole(store, input.taskId, input.roleName);
  const current = store.getRoleSessionSet(input.taskId, input.roleName)
    ?? createRoleSessionSet(
      { scope: "task", taskId: input.taskId, roleName: input.roleName },
      input.agentId,
      now
    );
  const existing = current.sessions[input.agentId];
  const effectiveExisting = nativeTransitionExisting(
    store,
    { scope: "task", taskId: input.taskId, roleName: input.roleName },
    existing,
    input.nativeSessionId,
    input.runtimeGenerationId,
    "Native session registration conflicts with the fixed Role session."
  );
  if (existing?.status === "active"
    && (input.runtimeGenerationId === undefined || existing.runtimeGenerationId === input.runtimeGenerationId)) return existing;
  const resolvedEffective = taskSessionEffective(
    store,
    input.taskId,
    input.roleName,
    input.agentId,
    effectiveExisting
  );
  const effective = input.effective === undefined
    ? resolvedEffective
    : validateEffectiveLaunchSnapshot(input.effective);
  if (!effectiveLaunchSnapshotsCompatibleForTaskSession(
    resolvedEffective,
    effective
  )) {
    throw new Error("Reserved native Session effective launch changed before persistence.");
  }
  if (effective.agentId !== input.agentId || effective.adapterId !== input.adapterId) {
    throw new Error("Native session registration does not match the effective runtime generation identity.");
  }
  const updated = recordRoleAgentSession(current, {
    agentId: input.agentId,
    adapterId: input.adapterId,
    nativeSessionId: input.nativeSessionId,
    ...(input.runtimeGenerationId === undefined ? {} : { runtimeGenerationId: input.runtimeGenerationId }),
    policy: "fixed",
    status: "active",
    effective: effectiveExisting?.effective ?? effective
  }, now);
  store.saveRoleSessionSet(updated);
  return updated.sessions[input.agentId]!;
}

function recordGlobalRuntimeNativeSession(
  store: TaskStore,
  input: Readonly<{
    roleName: string;
    agentId: string;
    adapterId: string;
    runtimeGenerationId?: string;
    nativeSessionId: string;
    effective?: EffectiveLaunchSnapshot;
  }>,
  now: Date
): RoleAgentSession {
  const role = store.getGlobalRole(input.roleName);
  if (role === null) throw new Error(`Global Role not found: ${input.roleName}.`);
  const current: GlobalRoleSessionSet = store.getGlobalRoleSessionSet(input.roleName)
    ?? createRoleSessionSet(
      { scope: "global", roleName: input.roleName },
      input.agentId,
      now
    );
  const existing = current.sessions[input.agentId];
  const effectiveExisting = nativeTransitionExisting(
    store,
    { scope: "global", roleName: input.roleName },
    existing,
    input.nativeSessionId,
    input.runtimeGenerationId,
    "Native session registration conflicts with the fixed global Role session."
  );
  if (existing?.status === "active"
    && (input.runtimeGenerationId === undefined || existing.runtimeGenerationId === input.runtimeGenerationId)) return existing;
  const resolvedEffective = globalSessionEffective(role, effectiveExisting);
  const effective = input.effective === undefined
    ? resolvedEffective
    : validateEffectiveLaunchSnapshot(input.effective);
  if (!effectiveLaunchSnapshotsCompatible(resolvedEffective, effective)) {
    throw new Error("Reserved global native Session effective launch changed before persistence.");
  }
  if (effective.agentId !== input.agentId || effective.adapterId !== input.adapterId) {
    throw new Error("Native session registration does not match the effective global runtime generation identity.");
  }
  const updated = recordRoleAgentSession(current, {
    agentId: input.agentId,
    adapterId: input.adapterId,
    nativeSessionId: input.nativeSessionId,
    ...(input.runtimeGenerationId === undefined ? {} : { runtimeGenerationId: input.runtimeGenerationId }),
    policy: "fixed",
    status: "active",
    effective
  }, now);
  store.saveGlobalRoleSessionSet(updated);
  return updated.sessions[input.agentId]!;
}

function nativeTransitionExisting(
  store: TaskStore,
  owner: RuntimeRoleOwner,
  existing: RoleAgentSession | undefined,
  nativeSessionId: string,
  runtimeGenerationId: string | undefined,
  conflictMessage: string
): RoleAgentSession | undefined {
  if (existing === undefined || existing.nativeSessionId === nativeSessionId) {
    return existing;
  }
  if (
    existing.status === "ended"
    && runtimeHookMatchesReservation(store, owner, runtimeGenerationId)
  ) {
    return undefined;
  }
  throw new Error(conflictMessage);
}

function globalCompletionNativeSessionId(
  existing: RoleAgentSession | undefined,
  input: Readonly<{
    agentId: string;
    adapterId: string;
    runtimeGenerationId?: string;
    nativeSessionId: string;
  }>
): string {
  // Codex structured event sources can expose different native IDs for the
  // same runtime generation. That generation remains the authoritative fence.
  return input.adapterId === "codex"
    && input.runtimeGenerationId !== undefined
    && existing?.runtimeGenerationId === input.runtimeGenerationId
    && existing.agentId === input.agentId
    && existing.adapterId === input.adapterId
    ? existing.nativeSessionId
    : input.nativeSessionId;
}

function mapRole(
  store: TaskStore,
  role: NonNullable<ReturnType<TaskStore["getRole"]>>
): SchedulerRole {
  const binding = activeRoleAgentBinding(role);
  const item = store.listWorkItems(role.taskId).find((candidate) => (
    candidate.assignee === role.name
      && !["completed", "failed", "retired"].includes(candidate.status)
  )) ?? null;
  const workspace = (item === null
    ? store.getTaskWorkspace(role.taskId)
    : store.getWorkItemWorkspace(role.taskId, item.id))
    ?? store.getTaskWorkspace(role.taskId)
    ?? undefined;
  const reopened = role.name === "leader"
    && store.getPendingWakeup(role.taskId)?.reasons.includes("task-reopened") === true;
  const liveSession = activeLiveRoleAgentSession(
    store.getTaskRoleSessionSet(role.taskId, role.name)
  );
  const effective = reopened
    ? resolveEffectiveLaunch({
        role,
        purpose: "execution",
        ...(workspace === undefined ? {} : { workspace })
      })
    : liveSession !== null && workspace?.owner.type === "task"
      ? effectiveLaunchWithTaskMainWorkspace(liveSession.effective, workspace)
      : liveSession?.effective ?? resolveEffectiveLaunch({
          role,
          purpose: "execution",
          ...(workspace === undefined ? {} : { workspace })
        });
  return {
    taskId: role.taskId,
    name: role.name,
    activeAgentId: role.activeAgentId,
    adapterId: binding.adapterId,
    ...(binding.config.model === undefined ? {} : { model: binding.config.model }),
    ...(binding.config.effort === undefined ? {} : { effort: binding.config.effort }),
    effective,
    workspace: role.workspace,
    ...(workspace === undefined ? {} : { managedWorkspace: workspace })
  };
}

function taskSessionEffective(
  store: TaskStore,
  taskId: string,
  roleName: string,
  agentId: string,
  existing: RoleAgentSession | undefined
) {
  const active = store.getActiveTurn(taskId, roleName);
  if (active !== null) {
    if (active.effective.agentId !== agentId) {
      throw new Error(
        `Native Session registration does not match the effective Turn Agent: ${taskId}/${roleName}.`
      );
    }
    if (existing !== undefined) {
      if (!effectiveLaunchSnapshotsCompatibleForTaskSession(
        existing.effective,
        active.effective
      )) {
        throw new Error(
          `Native Session effective launch does not match the active Turn: ${taskId}/${roleName}.`
        );
      }
      return existing.effective;
    }
    return active.effective;
  }
  if (existing !== undefined) return existing.effective;
  const role = store.getRole(taskId, roleName);
  if (role === null) throw new Error(`Role not found: ${taskId}/${roleName}.`);
  const item = store.listWorkItems(taskId).find((candidate) => (
    candidate.assignee === roleName
      && !["completed", "failed", "retired"].includes(candidate.status)
  )) ?? null;
  const workspace = (item === null
    ? store.getTaskWorkspace(taskId)
    : store.getWorkItemWorkspace(taskId, item.id))
    ?? store.getTaskWorkspace(taskId)
    ?? undefined;
  const effective = resolveEffectiveLaunch({
    role,
    purpose: "execution",
    ...(workspace === undefined ? {} : { workspace }),
    ...(item === null ? {} : { workItemWriteProjectIds: item.writeProjectIds })
  });
  if (effective.agentId !== agentId) {
    throw new Error(`Native Session registration does not match Role desired Agent: ${agentId}.`);
  }
  return effective;
}

function globalSessionEffective(
  role: Parameters<typeof resolveEffectiveLaunch>[0]["role"],
  existing: RoleAgentSession | undefined,
) {
  return existing?.effective ?? resolveEffectiveLaunch({ role, purpose: "execution" });
}

function mapSession(session: RoleAgentSession): SchedulerRoleSession {
  return {
    agentId: session.agentId,
    adapterId: session.adapterId,
    nativeSessionId: session.nativeSessionId,
    ...(session.runtimeGenerationId === undefined ? {} : { runtimeGenerationId: session.runtimeGenerationId }),
    ...(session.title === undefined ? {} : { title: session.title }),
    status: session.status,
    ...(session.endReason === undefined ? {} : { endReason: session.endReason }),
    effective: session.effective,
    updatedAt: session.updatedAt
  };
}

function saveTaskSession(
  store: TaskStore,
  role: NonNullable<ReturnType<TaskStore["getRole"]>>,
  session: SchedulerRoleSession & { nativeSessionId: string },
  status: AgentSessionStatus,
  now: Date,
  runtimeGenerationId?: string
): void {
  const current = store.getRoleSessionSet(role.taskId, role.name)
    ?? createRoleSessionSet(
      { scope: "task", taskId: role.taskId, roleName: role.name },
      session.agentId,
      now
    );
  const updated = recordRoleAgentSession(current, {
    agentId: session.agentId,
    adapterId: session.adapterId,
    nativeSessionId: session.nativeSessionId,
    ...(runtimeGenerationId === undefined ? {} : { runtimeGenerationId }),
    ...(session.title === undefined ? {} : { title: session.title }),
    policy: "fixed",
    status,
    ...(status !== "ended" || session.endReason === undefined
      ? {}
      : { endReason: session.endReason }),
    effective: session.effective
  }, now);
  store.saveRoleSessionSet(updated);
}

function matchesStallSessionFence(
  current: SchedulerRoleSession | null,
  expected: RoleTurnStallPersistence["session"]
): boolean {
  if (current === null || expected === null) return current === expected;
  return current.agentId === expected.agentId
    && current.adapterId === expected.adapterId
    && current.nativeSessionId === expected.nativeSessionId
    && current.runtimeGenerationId === expected.runtimeGenerationId
    && current.status === expected.status;
}

function requireRole(store: TaskStore, taskId: string, roleName: string) {
  const role = store.getRole(taskId, roleName);
  if (role === null) throw new Error(`Role not found: ${taskId}/${roleName}.`);
  return role;
}

function turnLaunchEventPayload(turn: Turn): Record<string, string> {
  return {
    turnId: turn.id,
    role: turn.roleName,
    purpose: turn.purpose,
    mode: turn.mode,
    agent: `${turn.effective.agentId}/${turn.effective.adapterId}`,
    effectiveRevision: String(turn.effective.sourceDesiredRevision),
    profileAccess: turn.effective.profileAccess,
    effectivePermission: turn.effective.permission.strategy,
    writeProjectIds: turn.effective.writeProjectIds.join(",") || "none"
  };
}

function runtimeObservationTelemetryEntry(
  input: RuntimeObservation
): TelemetryProgressEntry {
  return {
    taskId: input.fence.taskId!,
    roleName: input.fence.roleName,
    turnId: input.fence.turnId!,
    generation: input.fence.runtimeGenerationId,
    progressId: [
      input.kind,
      input.payload.operationId ?? input.payload.activity ?? "state"
    ].join(":"),
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
    payload: {
      eventId: input.eventId,
      kind: input.kind,
      authority: input.authority,
      driverId: input.fence.driverId,
      runtimeGenerationId: input.fence.runtimeGenerationId,
      nativeSessionId: input.fence.nativeSessionId ?? "",
      nativeTurnId: input.fence.nativeTurnId ?? "",
      ...(input.payload.operation === undefined
        ? {}
        : { operation: input.payload.operation }),
      ...(input.payload.activity === undefined
        ? {}
        : { activity: input.payload.activity }),
      ...(input.payload.usage === undefined
        ? {}
        : { usage: JSON.stringify(input.payload.usage) })
    },
    receivedAt: input.receivedAt
  };
}

/**
 * Usage observations and incomplete request boundaries are authoritative
 * read-only history: retain each one so consecutive deltas remain projectable.
 * Other activity observations are a current explicit boundary and may replace
 * their predecessor. Token evidence never becomes lifecycle activity.
 */
function compactedRuntimeObservationIds(
  events: readonly TaskEvent[],
  incoming: RuntimeObservation
): string[] {
  const existing = events.flatMap((event) => {
    const observation = runtimeObservationFromTaskEvent(event);
    const matches = incoming.kind.startsWith("operation.")
      ? observation !== null
        && runtimeObservationTurnFenceMatches(observation.fence, incoming.fence)
      : observation !== null
        && runtimeObservationFenceMatches(observation.fence, incoming.fence);
    return observation !== null
      && matches
      ? [{ event, observation }]
      : [];
  });
  const remove = ({ observation }: typeof existing[number]): boolean => {
    if (incoming.kind === "activity.observed") {
      if (isRuntimeTokenEvidence(incoming)) return false;
      return observation.kind === "activity.observed"
        && !isRuntimeTokenEvidence(observation);
    }
    if (incoming.kind === "operation.started") {
      return (observation.kind === "operation.started"
          && observation.payload.operationId === incoming.payload.operationId)
        || observation.kind === "operation.completed"
        || observation.kind === "operation.failed";
    }
    if (incoming.kind === "operation.completed" || incoming.kind === "operation.failed") {
      return (observation.kind.startsWith("operation.")
          && observation.payload.operationId === incoming.payload.operationId)
        || observation.kind === "operation.completed"
        || observation.kind === "operation.failed";
    }
    if (incoming.kind === "turn.waiting") return observation.kind === "turn.waiting";
    if (incoming.kind === "observer.health") {
      return observation.kind === "observer.health"
        && observation.payload.sourceId === incoming.payload.sourceId;
    }
    if (["turn.completed", "turn.failed", "turn.cancelled"].includes(incoming.kind)) {
      return (observation.kind.startsWith("operation.")
          && observation.payload.operation !== "subagent")
        || observation.kind === "turn.waiting"
        || observation.kind === "turn.completed"
        || observation.kind === "turn.failed"
        || observation.kind === "turn.cancelled";
    }
    if (incoming.kind === "turn.accepted") return observation.kind === "turn.accepted";
    if (incoming.kind.startsWith("session.")) return observation.kind.startsWith("session.");
    return false;
  };
  return existing.filter(remove).map(({ event }) => event.id);
}

function recordStructuredProviderAcceptance(
  sessions: TaskRoleSessionSet,
  input: RuntimeObservation,
  now: Date
): TaskRoleSessionSet {
  const current = sessions.providerBinding;
  const attemptId = input.fence.receiptId;
  const turnId = input.fence.nativeTurnId;
  if (current === null || attemptId === undefined || turnId === undefined) return sessions;
  if (current.turn === null
    || current.turn.turnId !== input.fence.turnId) return sessions;
  if (current.turn.attemptId === attemptId
    && ["accepted", "completed", "failed", "cancelled"].includes(
      current.turn.status
    )) return sessions;
  const binding = acceptProviderTurn(current, {
    attemptId,
    nativeTurnId: turnId,
    acceptedAt: input.observedAt ?? input.receivedAt
  });
  return updateTaskRoleProviderRuntime(sessions, binding, now);
}

/**
 * A Provider may expose the same accepted input through more than one exact
 * observation surface. Preserve the first native Turn identity bound to the
 * durable attempt; a later transport alias may settle that same attempt but
 * must neither replace nor strand the canonical identity.
 */
function canonicalStructuredProviderTurnId(
  sessions: TaskRoleSessionSet,
  observedTurnId: string,
  attemptId: string | undefined
): string {
  const turn = sessions.providerBinding?.turn;
  return attemptId !== undefined
    && turn?.attemptId === attemptId
    && turn.nativeTurnId !== undefined
    ? turn.nativeTurnId
    : observedTurnId;
}

function terminalSessionReplacementBasis(
  sessions: TaskRoleSessionSet,
  input: RuntimeObservation,
  run: Turn
): "terminal-session" | undefined {
  const binding = sessions.providerBinding;
  const session = sessions.sessions[input.fence.agentId];
  const incomingConversationId = input.fence.conversationId ?? input.fence.nativeSessionId;
  if (run.mode !== "new"
    || binding === null
    || session === undefined
    || incomingConversationId === undefined
    || currentProviderConversation(binding).conversationId === incomingConversationId
    || currentProviderActivation(binding) !== null
    || binding.authority.owner !== "none") {
    return undefined;
  }
  // Pre-start persistence may already have replaced the terminal Role Session
  // before Provider readiness arrives. A matching new Session plus the
  // quiescent old Provider binding preserves the same terminal-session proof.
  return session.status === "ended"
    || session.nativeSessionId === input.fence.nativeSessionId
    ? "terminal-session"
    : undefined;
}

function bindOrSupersedeProviderRuntime(
  sessions: TaskRoleSessionSet,
  input: RuntimeObservation,
  now: Date,
  replacementBasis?: "terminal-session"
): TaskRoleSessionSet {
  const conversationId = input.fence.conversationId ?? input.fence.nativeSessionId!;
  const activationId = input.fence.activationId ?? input.fence.runtimeGenerationId;
  if (sessions.providerBinding === null) {
    return bindTaskRoleProviderRuntime(sessions, createProviderRuntimeBinding({
      providerNamespace: input.fence.driverId,
      accountScope: input.fence.agentId,
      conversationId,
      activationId,
      startedAt: input.observedAt ?? input.receivedAt
    }), now);
  }
  const current = currentProviderConversation(sessions.providerBinding);
  if (current.conversationId === conversationId) {
    const active = currentProviderActivation(sessions.providerBinding);
    if (active?.activationId === activationId) return sessions;
    if (active !== null) {
      throw new Error(
        "Provider Conversation cannot start a second Activation while the current one is active."
      );
    }
    return updateTaskRoleProviderRuntime(
      sessions,
      startProviderActivation(sessions.providerBinding, {
        activationId,
        startedAt: input.observedAt ?? input.receivedAt
      }),
      now
    );
  }
  if (replacementBasis === undefined) {
    throw new Error("A fresh Provider Conversation requires a terminal prior Session.");
  }
  return updateTaskRoleProviderRuntime(
    sessions,
    supersedeProviderConversation(sessions.providerBinding, {
      conversationId,
      activationId,
      switchedAt: input.observedAt ?? input.receivedAt,
      basis: replacementBasis
    }),
    now
  );
}

function terminalProviderReplacementBasis(
  sessions: TaskRoleSessionSet,
  input: RuntimeObservation,
  mode: Turn["mode"]
): "terminal-session" | undefined {
  if (mode !== "new" || sessions.providerBinding === null) return undefined;
  if (sessions.providerBinding.providerNamespace !== input.fence.driverId
    || sessions.providerBinding.accountScope !== input.fence.agentId) {
    return undefined;
  }
  const current = sessions.sessions[input.fence.agentId];
  if (current === undefined
    || current.status !== "active"
    || current.nativeSessionId !== input.fence.nativeSessionId
    || current.runtimeGenerationId !== input.fence.runtimeGenerationId) {
    return undefined;
  }
  const replaced = [...(sessions.history ?? [])].reverse().find((session) => (
    session.agentId === current.agentId
    && session.adapterId === current.adapterId
    && session.status === "ended"
    && session.nativeSessionId !== current.nativeSessionId
  ));
  return replaced === undefined ? undefined : "terminal-session";
}

function settleStructuredProviderTurn(
  sessions: TaskRoleSessionSet,
  turnId: string,
  status: "completed" | "failed" | "cancelled",
  now: Date
): TaskRoleSessionSet {
  const binding = sessions.providerBinding;
  if (binding === null || binding.turn === null || binding.turn.nativeTurnId !== turnId) {
    return sessions;
  }
  if (["completed", "failed", "cancelled"].includes(binding.turn.status)) return sessions;
  return updateTaskRoleProviderRuntime(sessions, settleProviderTurn(binding, {
    nativeTurnId: turnId,
    status,
    settledAt: now.toISOString()
  }), now);
}

function usageSnapshotIsSuperseded(
  events: readonly TaskEvent[],
  incoming: RuntimeObservation
): boolean {
  if (incoming.kind !== "activity.observed" || incoming.payload.usage === undefined) {
    return false;
  }
  return events
    .map(runtimeObservationFromTaskEvent)
    .some((observation) => observation !== null
      && observation.kind === "activity.observed"
      && observation.payload.usage !== undefined
      && runtimeObservationFenceMatches(observation.fence, incoming.fence)
      && observationIsStrictlyNewer(observation, incoming));
}

function hasPersistedRuntimeObservation(
  events: readonly TaskEvent[],
  incoming: RuntimeObservation
): boolean {
  const usageIdentity = isRuntimeTokenEvidence(incoming)
    ? incoming.eventId
    : undefined;
  return events.some((event) => (
    event.type === RUNTIME_OBSERVATION_TASK_EVENT
    && (usageIdentity === undefined
      ? event.payload.semanticKey === incoming.semanticKey
      : event.payload.eventId === usageIdentity)
  ));
}

function observationIsStrictlyNewer(
  left: RuntimeObservation,
  right: RuntimeObservation
): boolean {
  return compareCanonicalObservationOrder(left, right) > 0;
}

function compareCanonicalObservationOrder(
  left: RuntimeObservation,
  right: RuntimeObservation
): number {
  return left.receivedAt.localeCompare(right.receivedAt)
    || (left.sequence ?? -1) - (right.sequence ?? -1)
    || (left.ordinal ?? -1) - (right.ordinal ?? -1)
    || left.eventId.localeCompare(right.eventId);
}
