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
  bindTaskRoleRun,
  clearTaskRoleProviderRuntimeForCleanup,
  clearTaskRoleRun,
  createRoleSessionSet,
  markTaskRoleRunDelivered,
  markTaskRoleRunPushed,
  prepareTaskRoleRunRedispatch,
  recordRoleAgentSession,
  recordTaskRoleTurnBoundary,
  rememberRoleAgentCompletedTurn,
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
  markProviderTurnDeliveryUnknown,
  rejectProviderTurn,
  settleProviderTurn,
  startProviderActivation,
  supersedeProviderConversation,
  updateProviderConversationRecoverability
} from "../runtime/providerRuntimeIdentity.js";
import { decideProviderRecovery } from "../runtime/providerRecoveryDecision.js";
import {
  hasRecentTurnId
} from "../executor/turnCompletion.js";
import { createTaskEvent, type TaskEvent } from "../event/taskEvent.js";
import { operationalTaskRecords } from "../task/taskRecordRetirement.js";
import {
  buildTaskWakeEnvelope,
  type WakeEnvelope
} from "../context/wakeNotification.js";
import { createTaskWake, fallbackWakeCursor, latestTaskWake } from "../scheduler/taskWake.js";
import {
  rolloverTaskRoleSessionForContextBudget,
  type ContextBudgetRolloverResult
} from "../lifecycle/contextBudgetRollover.js";
import {
  resolveContextBudget,
  type ResolvedContextBudget
} from "../config/yuiConfig.js";
import { answerInputRequest } from "../input/inputRequest.js";
import { activeRoleAgentBinding, updateRoleStatus } from "../role/role.js";
import {
  effectiveLaunchWithTaskMainWorkspace,
  effectiveLaunchSnapshotsCompatible,
  effectiveLaunchSnapshotsCompatibleForTaskMain,
  resolveEffectiveLaunch,
  validateEffectiveLaunchSnapshot,
  type EffectiveLaunchSnapshot
} from "../executor/effectiveLaunch.js";
import { SYSTEM_OPERATOR_ROLE } from "../role/systemRoles.js";
import {
  failAgentRun,
  markAgentRunDelivered,
  markAgentRunPushed,
  reopenRunForProviderRetry,
  clearProviderRetryOnProgress,
  agentRunDeliveryReceiptId,
  withAgentRunControlRequest,
  withProviderRetry,
  type AgentRun
} from "../run/agentRun.js";
import {
  createWorkflowOutcomeRequest,
  markWorkflowOutcomeRequestDispatched
} from "../run/runControlRequest.js";
import {
  classifyProviderError,
  isRetryableProviderErrorClass
} from "../lifecycle/providerErrorClass.js";
import type { ProviderErrorCode } from "../runtime/providerErrorCodes.js";
import {
  type PendingProviderRetry,
  deferProviderRetry,
  markProviderRetryDispatched,
  providerRetryIsDue,
  scheduleProviderRetry
} from "../run/providerRetry.js";
import {
  providerRetryAdapterEnabled,
  providerRetryConfig
} from "../run/providerRetryConfig.js";
import {
  classifyRuntimeProcessExit,
  validateRuntimeProcessExitObservation
} from "../runtime/processExitObservation.js";
import { terminalizeExactTaskRun } from "../lifecycle/exactRunTerminalization.js";
import {
  createCanonicalLifecycleEvent,
  foldCanonicalLifecycleEvent,
  type CanonicalIdentityFence,
  type CanonicalRunExpectation
} from "../lifecycle/canonicalLifecycleEvent.js";
import type {
  ProviderLifecycleObservation,
} from "./runtimeEventProcessor.js";
import type {
  DormantRuntimeOwnerCandidate,
  LeaderDispatchFailurePersistence,
  LeaderDispatchClaimResult,
  LeaderDispatchPersistence,
  RoleRunDeliveryFailurePersistence,
  RoleRunDeliveryPersistence,
  RoleRunProgressPersistence,
  RoleRunStallPersistence,
  SchedulerRunProgress,
  SchedulerRole,
  SchedulerRoleSession,
  SchedulerStorePort,
  RunProgressFacts,
  ExitedRoleRunPersistence
} from "../scheduler/ports.js";
import { recordLeaderFailure } from "../scheduler/leaderFailure.js";
import {
  createLeaderRecoveryNotification,
  createLeaderStallNotification
} from "../scheduler/operatorNotification.js";
import { pendingWakeupsMatch } from "../scheduler/pendingWakeup.js";
import { queueLeaderWakeup } from "../scheduler/wakeupQueue.js";
import { wakeReason } from "../scheduler/wakeReason.js";
import {
  foldRunProgressFacts,
  latestRunDurableProgressAt,
  latestRunEventTime,
  latestStallEvidenceKey,
  isRoleRunStalled,
  clearMatchingLeaderStallAttention,
  RUN_PROGRESS_EVENT,
  RUN_RECOVERED_EVENT,
  RUN_STALLED_EVENT
} from "../scheduler/roleRunStall.js";
import type { TaskStore } from "../storage/taskStore.js";
import type {
  RuntimeSessionCandidate,
  RuntimeSessionCandidateQuery
} from "../runtime/runtimeSessionCandidate.js";
import { projectProviderContinuations } from "../runtime/runtimeContinuationProjection.js";
import { providerContinuationKey } from "../runtime/providerContinuation.js";
import {
  currentWorkItemExecutionGroup,
  updateWorkItemExecutionGroup,
  updateWorkItemStatus,
  workItemOwnsUnresolvedExecutionLane
} from "../workItem/workItem.js";
import { recordExecutionLaneResult } from "../execution/executionGroup.js";
import {
  formatAgentRunReceiptId,
  formatTaskRecordReference
} from "../task/taskRecordReference.js";
import {
  bindExecution,
  claimPending,
  claimInputDelivery as claimMailboxInputDelivery,
  completeInputDelivery as completeMailboxInputDelivery,
  completeProcessing,
  mailboxHasPending,
  mailboxHasWork,
  pendingLane,
  markInputDeliveryPushed as markMailboxInputDeliveryPushed,
  markInputDeliveryUnknown as markMailboxInputDeliveryUnknown,
  releaseInputDelivery as releaseMailboxInputDelivery,
  resolveInputDeliveryNotAccepted as resolveMailboxInputDeliveryNotAccepted,
  releaseProcessing,
  type InputDelivery,
  type MailboxTarget,
  type WorkMailbox
} from "../coordination/workMailbox.js";
import { enqueueWork } from "../coordination/workMailboxQueue.js";
import type { SchedulerMailboxClaimInput, SchedulerMailboxClaimResult } from "../scheduler/ports.js";
import {
  RUNTIME_CLEANUP_REQUIRED_REASON,
  RUNTIME_LAUNCH_RESERVED_REASON,
  RUNTIME_LIFECYCLE_OWNER,
  RuntimeLifecycleBusyError,
  hasRuntimeCleanupObligation,
  hasRuntimeLifecycleWork,
  isRuntimeLaunchReservation,
  runtimeLifecycleTarget,
  type RuntimeLifecycleTarget,
  type RuntimeRoleOwner
} from "../runtime/lifecycleReservation.js";
import { nativeSessionIdForLaunch } from "../runtime/preallocatedNativeSession.js";
import {
  builtinAgentDriverRegistry
} from "../runtime/builtinAgentDrivers.js";
import type { AgentDriverRegistry } from "../runtime/agentDriver.js";
import {
  RUNTIME_OBSERVATION_TASK_EVENT,
  createRuntimeObservation,
  runtimeObservationFenceMatches,
  runtimeObservationFromTaskEvent,
  runtimeObservationRunFenceMatches,
  runtimeObservationTaskEventPayload,
  type RuntimeObservation
} from "../runtime/runtimeObservation.js";
import { projectRuntimeTaskEvents } from "../runtime/runtimeProjection.js";
import { contextSnapshotRef } from "../context/contextSnapshot.js";
import {
  contextSnapshotDeltaRefIds,
  freezeRunContextSnapshot
} from "../context/runContextPack.js";

/**
 * One durable revision's read-only facts for one Task. A scheduler pass reads
 * the same revision's large event history once per Task and folds the per-Run
 * progress facts in a single O(events) pass; every per-Role/per-phase query is
 * then served from this bounded projection instead of re-cloning and
 * re-scanning the whole history per candidate. The projection is rebuilt as
 * soon as the durable revision advances (own commit or external writer), so it
 * is never dispatch/claim/complete authority: every mutation re-reads the
 * exact records under the storage lock/CAS.
 *
 * All seven record families the actionability digest folds (agentRuns,
 * workItems, reviewRounds, integrationAttempts, inputRequests, durableJobs,
 * messages) are read in the same projection build, so a single digest
 * computation sees a consistent per-revision snapshot even under concurrent
 * writers (Issue 05).
 */
type TaskReadProjection = Readonly<{
  events: readonly TaskEvent[];
  runFacts: ReadonlyMap<string, RunProgressFacts>;
  agentRuns: ReturnType<TaskStore["listAgentRuns"]>;
  workItems: ReturnType<TaskStore["listWorkItems"]>;
  reviewRounds: ReturnType<TaskStore["listReviewRounds"]>;
  changeSets: ReturnType<TaskStore["listChangeSets"]>;
  integrationAttempts: ReturnType<TaskStore["listIntegrationAttempts"]>;
  inputRequests: ReturnType<TaskStore["listInputRequests"]>;
  durableJobs: ReturnType<TaskStore["listDurableJobs"]>;
  messages: ReturnType<TaskStore["listMessages"]>;
}>;

export type TaskRuntimeTurnFailed = Readonly<{
  eventId: string;
  eventType: string;
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: string;
  launchId: string;
  nativeSessionId: string;
  nativeTurnId: string;
  runId: string;
  /** Structured Provider error code, when the driver could extract one. */
  errorCode?: ProviderErrorCode;
  error: string;
  errorDetails?: string;
  lastAssistantMessage?: string;
  retryAfterMs?: number;
}>;

export class AgentHostProviderTurnFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentHostProviderTurnFenceError";
  }
}

/** Maps the authoritative FileTaskStore records to the scheduler's narrow port. */
export class FileSchedulerStoreAdapter implements SchedulerStorePort {
  /** Diagnostic telemetry is optional and never participates in runtime truth. */
  constructor(
    readonly store: TaskStore,
    private readonly telemetry: SchedulerTelemetry | null = null,
    private readonly drivers: AgentDriverRegistry = builtinAgentDriverRegistry()
  ) {}

  freezeLeaderContextSnapshot(taskId: string, roleName: string, now: Date) {
    return this.store.transaction((tx) => {
      const snapshot = freezeRunContextSnapshot(tx, {
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
   * the exact durable Run/session fence, applies the small workflow-relevant
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
      return this.recordObsoleteCanonicalObservation(input, "driver-or-run-mismatch", now);
    }
    if (this.store.listEvents(taskId).some((event) => (
      event.type === RUNTIME_OBSERVATION_TASK_EVENT
      && event.payload.semanticKey === input.semanticKey
    ))) return "applied";
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
      case "turn.completed": {
        const completed = {
          taskId,
          roleName: input.fence.roleName,
          agentId: input.fence.agentId,
          adapterId,
          launchId: input.fence.launchId,
          nativeSessionId: input.fence.nativeSessionId!,
          turnId: input.fence.nativeTurnId!,
          runId: input.fence.runId,
          summary: input.payload.summary ?? "Agent turn completed without a workflow outcome."
        };
        const classification = this.classifyRuntimeTurnCompleted(completed);
        if (classification !== "apply") return classification;
        if (this.runtimeTurnHasActiveNativeSubagents(input)) {
          // This is an intermediate provider Turn boundary, not the end of the
          // durable Yui Run. The provider will deliver child completion
          // notifications as later native Turns in the same Run generation.
          outcome = this.validateCanonicalRunObservation(input, now);
          break;
        }
        const result = this.observeRuntimeTurnCompleted(completed, now);
        outcome = result.disposition === "obsolete" ? "obsolete" : "applied";
        break;
      }
      case "turn.failed": {
        const failureEvidence = input.payload.failure!;
        if (failureEvidence.runTerminal !== true) {
          const classification = this.classifyRuntimeTurnCompleted({
            taskId,
            roleName: input.fence.roleName,
            agentId: input.fence.agentId,
            adapterId,
            launchId: input.fence.launchId,
            nativeSessionId: input.fence.nativeSessionId!,
            turnId: input.fence.nativeTurnId!,
            runId: input.fence.runId
          });
          if (classification !== "apply") return classification;
          const boundary = this.observeRuntimeTurnCompleted({
            taskId,
            roleName: input.fence.roleName,
            agentId: input.fence.agentId,
            adapterId,
            launchId: input.fence.launchId,
            nativeSessionId: input.fence.nativeSessionId!,
            turnId: input.fence.nativeTurnId!,
            runId: input.fence.runId,
            summary: input.payload.summary ?? `Provider Turn failed: ${failureEvidence.code}.`,
            providerStatus: "failed"
          }, now);
          outcome = boundary.disposition === "obsolete" ? "obsolete" : "applied";
          break;
        }
        const failure = {
          eventId: input.eventId,
          eventType: input.kind,
          taskId,
          roleName: input.fence.roleName,
          agentId: input.fence.agentId,
          adapterId,
          launchId: input.fence.launchId,
          nativeSessionId: input.fence.nativeSessionId!,
          nativeTurnId: input.fence.nativeTurnId!,
          runId: input.fence.runId!,
          ...(failureEvidence.errorCode === undefined
            ? {}
            : { errorCode: failureEvidence.errorCode }),
          error: failureEvidence.code,
          ...(failureEvidence.details === undefined
            ? {}
            : { errorDetails: failureEvidence.details }),
          ...(failureEvidence.lastOutput === undefined
            ? {}
            : { lastAssistantMessage: failureEvidence.lastOutput }),
          ...(failureEvidence.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: failureEvidence.retryAfterMs })
        };
        if (this.classifyRuntimeTurnFailed(failure) !== "apply") return "obsolete";
        outcome = this.observeRuntimeTurnFailed(failure, now).disposition === "applied"
          ? "applied"
          : "obsolete";
        break;
      }
      case "operation.started":
      case "operation.completed":
      case "operation.failed":
      case "turn.waiting":
      case "turn.cancelled":
      case "activity.observed":
      case "observer.health":
      case "native-work.snapshot":
      case "continuation.started":
      case "continuation.reported":
      case "continuation.settled":
      case "input.delivery-unknown":
        outcome = this.validateCanonicalRunObservation(input, now);
        break;
      case "conversation.observed":
      case "activation.started":
      case "activation.ended":
      case "activation.failed":
        outcome = this.observeProviderRuntimeIdentity(input, now);
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
    if (outcome === "applied"
      && input.kind === "activity.observed"
      && input.payload.activityId !== undefined) {
      this.clearProviderRetryForProgress(input, "correlated-activity", now);
    }
    if (outcome === "applied") this.persistRuntimeObservation(input, now);
    return outcome;
  }

  private adapterForRuntimeObservation(
    input: RuntimeObservation
  ): string | null {
    const taskId = input.fence.taskId;
    const runId = input.fence.runId;
    if (taskId === undefined || runId === undefined) return null;
    const run = this.store.getAgentRun(taskId, runId);
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

  private validateCanonicalRunObservation(
    input: RuntimeObservation,
    now: Date
  ): ProviderLifecycleObservation {
    return this.store.transaction((store) => {
      if (store.listEvents(input.fence.taskId!).some((event) => (
        event.type === RUNTIME_OBSERVATION_TASK_EVENT
        && event.payload.semanticKey === input.semanticKey
      ))) return "applied";
      const run = store.getAgentRun(input.fence.taskId!, input.fence.runId!);
      const active = store.getActiveAgentRun(input.fence.taskId!, input.fence.roleName);
      const sessions = store.getTaskRoleSessionSet(input.fence.taskId!, input.fence.roleName);
      const session = sessions?.sessions[input.fence.agentId];
      const knownContinuation = input.kind.startsWith("continuation.")
        && projectProviderContinuations(store.listEvents(input.fence.taskId!)).some((entry) => (
          entry.runId === input.fence.runId
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
          session?.launchId === input.fence.launchId
          && session.nativeSessionId === input.fence.nativeSessionId
          && input.fence.sessionGenerationId === input.fence.launchId
        ))
        && runtimeReceiptBelongsToRun(store, input)
        && (run.deliveredAt !== undefined || input.kind === "turn.cancelled");
      if (!valid) {
        recordCanonicalObservationObsolete(store, input, "runtime-fence-not-current", now);
        return "obsolete";
      }
      return "applied";
    });
  }

  private runtimeTurnHasActiveNativeSubagents(input: RuntimeObservation): boolean {
    const taskId = input.fence.taskId!;
    const run = this.store.getAgentRun(taskId, input.fence.runId!);
    if (run === null) return false;
    const projection = projectRuntimeTaskEvents(
      input.fence,
      run.createdAt,
      this.store.listEvents(taskId)
    );
    return Object.values(projection.operations).some(({ kind }) => kind === "subagent");
  }

  private validateCanonicalSessionObservation(
    input: RuntimeObservation,
    now: Date
  ): ProviderLifecycleObservation {
    return this.store.transaction((store) => {
      const run = store.getAgentRun(input.fence.taskId!, input.fence.runId!);
      const sessions = store.getTaskRoleSessionSet(input.fence.taskId!, input.fence.roleName);
      const session = sessions?.sessions[input.fence.agentId];
      if (run === null
        || run.roleName !== input.fence.roleName
        || run.effective.agentId !== input.fence.agentId
        || this.drivers.requireByAdapterId(run.effective.adapterId).id !== input.fence.driverId
        || session?.launchId !== input.fence.launchId
        || session.nativeSessionId !== input.fence.nativeSessionId
        || input.fence.sessionGenerationId !== input.fence.launchId) {
        recordCanonicalObservationObsolete(store, input, "runtime-session-not-current", now);
        return "obsolete";
      }
      const status: AgentSessionStatus = input.kind === "session.failed" ? "broken" : "stopped";
      let updatedSessions = updateRoleAgentSessionStatus(
        sessions!,
        input.fence.agentId,
        status,
        now
      );
      if (updatedSessions.providerBinding !== null) {
        const activationId = input.fence.activationId ?? input.fence.launchId;
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
        if (continuation.runId !== input.fence.runId
          || continuation.identity.conversationId
            !== (input.fence.conversationId ?? input.fence.nativeSessionId)
          || continuation.identity.activationId
            !== (input.fence.activationId ?? input.fence.launchId)
          || continuation.execution === "quiescent"
          || continuation.attachment === "detached") continue;
        const key = providerContinuationKey(continuation.identity);
        const identityDigest = createHash("sha256").update(key).digest("hex");
        const detached = createRuntimeObservation({
          schemaVersion: 2,
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
        store.saveEvent(input.fence.taskId!, createTaskEvent(
          eventId,
          input.fence.taskId!,
          RUNTIME_OBSERVATION_TASK_EVENT,
          runtimeObservationTaskEventPayload(detached),
          now
        ));
        enqueueWork(store, {
          kind: "role",
          taskId: input.fence.taskId!,
          roleName: "leader"
        }, "provider-continuation-detached", now, [
          { type: "event", taskId: input.fence.taskId!, id: eventId }
        ], {
          source: input.fence.driverId,
          dedupeKey: detached.semanticKey,
          deliveryMode: "followup",
          lane: "normal"
        });
      }
      const active = store.getActiveAgentRun(input.fence.taskId!, input.fence.roleName);
      const role = store.getRole(input.fence.taskId!, input.fence.roleName);
      if ((input.kind === "session.ended" || input.kind === "session.failed")
        && active !== null
        && active.id === input.fence.runId
        && active.status === "active"
        && active.deliveredAt !== undefined
        && role !== null) {
        store.saveRole(input.fence.taskId!, updateRoleStatus(role, "detached", now));
        if (role.name === "leader") {
          const message = [
            `Leader native Session became unavailable while Run ${active.id} remains active.`,
            "Yui preserved the Run because Session/host termination is not a workflow outcome.",
            "Inspect native-child and mailbox facts, then explicitly continue, reset, or request user input."
          ].join(" ");
          store.saveOperatorNotification(createLeaderRecoveryNotification(
            input.fence.taskId!,
            message,
            now,
            store.getOperatorNotification(input.fence.taskId!)
          ));
          enqueueWork(store, { kind: "operator" }, "leader-runtime-detached", now, [
            { type: "run", taskId: input.fence.taskId!, id: active.id }
          ]);
        } else {
          enqueueWork(store, {
            kind: "role",
            taskId: input.fence.taskId!,
            roleName: "leader"
          }, "role-runtime-detached", now, [
            { type: "run", taskId: input.fence.taskId!, id: active.id }
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
      if (events.some((event) => (
        event.type === RUNTIME_OBSERVATION_TASK_EVENT
        && event.payload.semanticKey === input.semanticKey
      ))) return;
      if (usageSnapshotIsSuperseded(events, input)) return;
      const confirmedActivity = confirmedUsageActivityObservation(events, input);
      const removable = [
        ...compactedRuntimeObservationIds(events, input),
        ...(confirmedActivity === null
          ? []
          : compactedRuntimeObservationIds(events, confirmedActivity))
      ];
      if (removable.length > 0) store.removeEvents(taskId, removable);
      const observationEventId = store.nextEventId(taskId);
      store.saveEvent(taskId, createTaskEvent(
        observationEventId,
        taskId,
        RUNTIME_OBSERVATION_TASK_EVENT,
        runtimeObservationTaskEventPayload(input),
        now
      ));
      if (input.kind === "native-work.snapshot"
        && input.payload.snapshotComplete === true
        && input.payload.observationQuality === "exact") {
        for (const continuation of projectProviderContinuations(events)) {
          if (continuation.runId !== input.fence.runId
            || continuation.identity.conversationId !== input.fence.conversationId
            || continuation.identity.activationId !== input.fence.activationId
            || continuation.execution === "quiescent") continue;
          const identityKey = providerContinuationKey(continuation.identity);
          const digest = createHash("sha256")
            .update(`${input.semanticKey}\u0000${identityKey}`)
            .digest("hex");
          const settled = createRuntimeObservation({
            schemaVersion: 2,
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
          store.saveEvent(taskId, createTaskEvent(
            settledEventId,
            taskId,
            RUNTIME_OBSERVATION_TASK_EVENT,
            runtimeObservationTaskEventPayload(settled),
            now
          ));
          enqueueWork(
            store,
            { kind: "role", taskId, roleName: "leader" },
            "provider-continuation-settled",
            now,
            [{ type: "event", taskId, id: settledEventId }],
            {
              source: input.fence.driverId,
              dedupeKey: settled.semanticKey,
              deliveryMode: "followup",
              lane: "normal"
            }
          );
        }
      }
      if (input.kind === "continuation.reported"
        || input.kind === "continuation.settled") {
        enqueueWork(
          store,
          { kind: "role", taskId, roleName: "leader" },
          input.kind === "continuation.reported"
            ? "provider-continuation-report"
            : "provider-continuation-settled",
          now,
          [{ type: "event", taskId, id: observationEventId }],
          {
            source: input.fence.driverId,
            dedupeKey: input.semanticKey,
            deliveryMode: "followup",
            lane: "normal"
          }
        );
      }
      if (input.kind === "turn.failed" && input.payload.failure?.runTerminal !== true) {
        enqueueWork(
          store,
          { kind: "role", taskId, roleName: "leader" },
          "provider-turn-failed",
          now,
          [{ type: "event", taskId, id: observationEventId }],
          {
            source: input.fence.driverId,
            dedupeKey: input.semanticKey,
            deliveryMode: "followup",
            lane: "normal"
          }
        );
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
        if (role !== null && (session?.status === "stopped" || session?.status === "broken")) {
          enqueueWork(store, role.name === "leader"
            ? { kind: "operator" }
            : { kind: "role", taskId, roleName: "leader" },
          "detached-native-subagent-terminal",
          now,
          [{ type: "run", taskId, id: input.fence.runId! }]);
        }
      }
      if (confirmedActivity !== null) {
        store.saveEvent(taskId, createTaskEvent(
          store.nextEventId(taskId),
          taskId,
          RUNTIME_OBSERVATION_TASK_EVENT,
          runtimeObservationTaskEventPayload(confirmedActivity),
          now
        ));
      }
    });
    if (this.telemetry !== null && input.fence.runId !== undefined) {
      try {
        const entry = runtimeObservationTelemetryEntry(input);
        this.telemetry.sink.observe(entry);
        const run = this.store.getAgentRun(entry.taskId, input.fence.runId);
        if (run !== null && run.status !== "active") {
          void this.telemetry.retention.flush().then(() => {
            this.telemetry?.retention.pruneGeneration(
              entry.taskId,
              entry.roleName,
              entry.runId,
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
        runFacts: foldRunProgressFacts(events),
        agentRuns: this.store.listAgentRuns(taskId),
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

  getPresentationContext() {
    return { timeZone: this.store.getConfig().timeZone };
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
        leaderRunCreatedAt: operationalTaskRecords(
          reader.listAgentRuns(taskId),
          reader.listEvents(taskId),
          "agent-run"
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
  rolloverTaskRoleSessionForContextBudget(input: Readonly<{
    taskId: string;
    roleName: string;
    peakTokens: number;
    hardTokens: number;
    now: Date;
  }>): ContextBudgetRolloverResult | null {
    return this.store.transaction((reader) => rolloverTaskRoleSessionForContextBudget(
      reader,
      input.taskId,
      input.roleName,
      { peakTokens: input.peakTokens, hardTokens: input.hardTokens },
      input.now
    ));
  }
  getContextBudget(): ResolvedContextBudget {
    return resolveContextBudget(this.store.getConfig().contextBudget);
  }

  listRoles(taskId: string): SchedulerRole[] {
    return this.store.listRoles(taskId).map((role) => mapRole(this.store, role));
  }

  getRole(taskId: string, roleName: string): SchedulerRole | null {
    const role = this.store.getRole(taskId, roleName);
    return role === null ? null : mapRole(this.store, role);
  }

  getActiveAgentRun(taskId: string, roleName: string) {
    return this.store.getActiveAgentRun(taskId, roleName);
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
    if (effectiveSession?.status !== "ready") return null;
    return {
      roleName: SYSTEM_OPERATOR_ROLE,
      adapterId: effectiveSession.effective.adapterId
    } as const;
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
        if (task?.status !== "active" || request.policy.kind !== "recommended") continue;
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

  listAgentRuns(taskId: string) {
    return this.#taskReadProjection(taskId).agentRuns;
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

  getRunProgressFacts(taskId: string, runId: string): RunProgressFacts | undefined {
    return this.#taskReadProjection(taskId).runFacts.get(runId);
  }

  getRunDurableProgress(
    taskId: string,
    roleName: string,
    runId: string
  ): SchedulerRunProgress | null {
    const projected = this.#taskReadProjection(taskId);
    // Serve the related-record fold from the same revision's projection: the
    // event history and the WorkItem/Review/ChangeSet/Integration/Input lists
    // are read once per Task per revision, and the per-Run checkpoint/activity
    // facts come from the one-pass fold instead of per-candidate scans.
    const view = {
      getAgentRun: (id: string, agentRunId: string) => this.store.getAgentRun(id, agentRunId),
      listEvents: () => projected.events,
      getWorkItem: (id: string, workItemId: string) => this.store.getWorkItem(id, workItemId),
      listReviewRounds: () => projected.reviewRounds,
      listChangeSets: () => projected.changeSets,
      listIntegrationAttempts: () => projected.integrationAttempts,
      listInputRequests: () => projected.inputRequests
    };
    // A missing fold entry is an authoritative empty fold, not a signal to
    // re-scan the whole history. Pass {} so latestRunDurableProgressAt treats
    // the fold as present and skips the per-candidate fallback scans.
    return latestRunDurableProgressAt(view, taskId, roleName, runId, projected.runFacts.get(runId) ?? {});
  }

  recordRoleRunStall(
    input: RoleRunStallPersistence
  ): "raised" | "already-raised" | "state-changed" {
    return this.store.transaction((store) => {
      const task = store.getTask(input.taskId);
      const role = store.getRole(input.taskId, input.roleName);
      const run = store.getActiveAgentRun(input.taskId, input.roleName);
      if (
        task === null
        || task.status !== "active"
        || role === null
        || run === null
        || run.id !== input.runId
        || run.status !== "active"
        || run.effective.agentId !== input.agentId
        || run.effective.adapterId !== input.adapterId
      ) return "state-changed";

      const progress = latestRunDurableProgressAt(
        store,
        input.taskId,
        input.roleName,
        input.runId
      );
      if (progress?.progressAt !== input.progressAt) return "state-changed";

      const session = store.getRoleSession(input.taskId, input.roleName);
      if (!matchesStallSessionFence(session, input.session)) return "state-changed";

      const existing = latestStallEvidenceKey(store.listEvents(task.id), run.id);
      if (existing?.progressAt === input.progressAt) return "already-raised";

      const event = createTaskEvent(
        store.nextEventId(task.id),
        task.id,
        RUN_STALLED_EVENT,
        {
          runId: run.id,
          roleName: role.name,
          kind: input.kind,
          classification: input.classification,
          progressAt: input.progressAt,
          idleMs: String(Math.max(0, Math.floor(input.idleMs))),
          evidenceKey: input.evidenceKey,
          status: "needs-attention"
        },
        input.now
      );
      store.saveEvent(task.id, event);
      if (role.name === "leader") {
        store.saveOperatorNotification(createLeaderStallNotification(
          task.id,
          run.id,
          input.progressAt,
          input.evidenceKey,
          input.now,
          store.getOperatorNotification(task.id)
        ));
        enqueueWork(store, { kind: "operator" }, "leader-run-stalled", input.now, [
          { type: "task", id: task.id }
        ]);
      } else {
        queueLeaderWakeup(store, task.id, wakeReason("role-run-stalled"), input.now);
      }
      return "raised";
    });
  }

  recordRoleRunProgress(
    input: RoleRunProgressPersistence
  ): "recorded" | "already-recorded" | "state-changed" {
    return this.store.transaction((store) => {
      const task = store.getTask(input.taskId);
      const run = store.getActiveAgentRun(input.taskId, input.roleName);
      if (
        task === null
        || task.status !== "active"
        || run === null
        || run.id !== input.runId
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
        event.type === RUN_PROGRESS_EVENT
        && event.payload.runId === run.id
        && (
          event.payload.progressAt === input.progressAt
          || (
            typeof event.payload.progressAt === "string"
            && Number.isFinite(Date.parse(event.payload.progressAt))
            && Date.parse(event.payload.progressAt) >= Date.parse(input.progressAt)
          )
        )
      ));
      const stalledAt = latestRunEventTime(events, RUN_STALLED_EVENT, run.id);
      const recoveredAt = latestRunEventTime(events, RUN_RECOVERED_EVENT, run.id);
      const recovered = stalledAt !== undefined
        && (recoveredAt === undefined || Date.parse(recoveredAt) <= Date.parse(stalledAt));
      if (!existing) {
        store.saveEvent(task.id, createTaskEvent(
          store.nextEventId(task.id),
          task.id,
          RUN_PROGRESS_EVENT,
          {
            runId: run.id,
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
          RUN_RECOVERED_EVENT,
          {
            runId: run.id,
            roleName: input.roleName,
            progressAt: input.progressAt,
            kind: "durable-progress"
          },
          input.now
        ));
        clearMatchingLeaderStallAttention(store, task.id, run.id);
      }
      return existing && !recovered ? "already-recorded" : "recorded";
    });
  }

  hasInFlightTurn(taskId: string, roleName: string): boolean {
    const sessions = this.store.getTaskRoleSessionSet(taskId, roleName);
    return sessions !== null && sessions.inFlight !== null;
  }

  beginAgentHostProviderTurn(input: Readonly<{
    taskId: string;
    roleName: string;
    runId: string;
    agentId: string;
    launchId: string;
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
      if (sessions === null || sessions === undefined
        || binding === null || binding === undefined
        || sessions.inFlight?.runId !== input.runId
        || binding.runId !== input.runId
        || session?.launchId !== input.launchId
        || session.nativeSessionId !== input.nativeSessionId
        || currentProviderConversation(binding).conversationId !== input.nativeSessionId
        || binding.authority.owner !== input.authorityOwner
        || binding.authority.epoch !== input.authorityEpoch
        || binding.authority.holderId !== input.holderId) {
        throw new AgentHostProviderTurnFenceError(
          "Agent Host Provider Turn carries a stale durable writer fence. Release and reacquire Provider authority before retrying input."
        );
      }
      const exactReplay = binding.turn?.attemptId === input.attemptId
        && binding.turn.authorityEpoch === input.authorityEpoch
        && binding.turn.status === "submitting";
      if (!exactReplay && binding.turn !== null
        && ["submitting", "accepted", "running", "delivery-unknown"]
          .includes(binding.turn.status)) {
        throw new AgentHostProviderTurnFenceError(
          "Provider Conversation already has an unsettled Turn."
        );
      }
      store.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(
        sessions,
        beginProviderTurn(binding, {
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
    runId: string;
    attemptId: string;
    status: "rejected" | "delivery-unknown";
    reason: string;
    now: Date;
  }>): void {
    this.store.transaction((store) => {
      const sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName);
      const binding = sessions?.providerBinding;
      if (sessions === null || sessions === undefined
        || binding === null || binding === undefined
        || binding.runId !== input.runId
        || binding.turn?.attemptId !== input.attemptId
        || binding.turn.status !== "submitting") {
        throw new Error("Agent Host Provider Turn submission is no longer current.");
      }
      const updated = input.status === "delivery-unknown"
        ? markProviderTurnDeliveryUnknown(binding, {
            attemptId: input.attemptId,
            observedAt: input.now.toISOString(),
            reason: input.reason
          })
        : rejectProviderTurn(binding, {
            attemptId: input.attemptId,
            rejectedAt: input.now.toISOString(),
            reason: input.reason
          });
      store.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(sessions, updated, input.now));
    });
  }

  getProviderAuthorityFence(input: Readonly<{
    taskId: string;
    roleName: string;
    runId: string;
    agentId: string;
    launchId: string;
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
      || binding.runId !== input.runId
      || session?.launchId !== input.launchId
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

  beginRoleRunProviderTurn(input: Readonly<{
    taskId: string;
    roleName: string;
    runId: string;
    agentId: string;
    launchId: string;
    nativeSessionId: string;
    attemptId: string;
    now: Date;
  }>): boolean {
    return this.store.transaction((store) => {
      const sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName);
      const session = sessions?.sessions[input.agentId];
      const binding = sessions?.providerBinding;
      if (sessions === null || sessions === undefined
        || binding === null || binding === undefined
        || sessions.inFlight?.runId !== input.runId
        || binding.runId !== input.runId
        || session?.launchId !== input.launchId
        || session.nativeSessionId !== input.nativeSessionId
        || currentProviderConversation(binding).conversationId !== input.nativeSessionId
        || binding.authority.owner !== "controller") return false;
      store.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(
        sessions,
        beginProviderTurn(binding, {
          attemptId: input.attemptId,
          authorityEpoch: binding.authority.epoch,
          submittedAt: input.now.toISOString()
        }),
        input.now
      ));
      return true;
    });
  }

  resolveRoleRunProviderSubmission(input: Readonly<{
    taskId: string;
    roleName: string;
    runId: string;
    attemptId: string;
    status: "rejected" | "delivery-unknown";
    reason: string;
    now: Date;
  }>): boolean {
    return this.store.transaction((store) => {
      const sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName);
      const binding = sessions?.providerBinding;
      if (sessions === null || sessions === undefined
        || binding === null || binding === undefined
        || binding.runId !== input.runId
        || binding.turn?.attemptId !== input.attemptId
        || binding.turn.status !== "submitting") return false;
      const updated = input.status === "delivery-unknown"
        ? markProviderTurnDeliveryUnknown(binding, {
            attemptId: input.attemptId,
            observedAt: input.now.toISOString(),
            reason: input.reason
          })
        : rejectProviderTurn(binding, {
            attemptId: input.attemptId,
            rejectedAt: input.now.toISOString(),
            reason: input.reason
          });
      store.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(sessions, updated, input.now));
      return true;
    });
  }

  isRoleGenerationProviderReady(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    launchId?: string;
    nativeSessionId?: string;
  }>): boolean {
    // A session.ready observation for this exact generation is the durable
    // pre-input fence. This reads folded Driver truth
    // only — no liveness, screen, or pane/PID inference. Served from the
    // revision projection: a stale miss only repeats an idempotent first push.
    return this.listEvents(input.taskId).some((event) => {
      const observation = runtimeObservationFromTaskEvent(event);
      return observation?.kind === "session.ready"
        && observation.fence.roleName === input.roleName
        && observation.fence.agentId === input.agentId
        && (input.launchId === undefined || observation.fence.launchId === input.launchId)
        && (input.nativeSessionId === undefined
          || observation.fence.nativeSessionId === input.nativeSessionId);
    });
  }

  peekNextAgentRunId(taskId: string): string {
    return this.store.peekNextAgentRunId(taskId);
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
    return this.store.transaction((store) => (
      queueLeaderWakeup(store, taskId, reason, now)
    ));
  }

  /**
   * Records that a Leader wake was suppressed by scheduler single-flight
   * (the Role runtime lifecycle lane was busy). The wake stays durable and
   * is retried after the lane settles; this event is the audit trail that
   * separates scheduler backpressure from real Run failures.
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
   * f6: The wakeup targets the Leader role mailbox (not the Task mailbox)
   * and also queues a pending wakeup so processLeaderWakeups dispatches
   * the Leader Run with the exact job-finished reason.
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
        queueLeaderWakeup(store, taskId, wakeup.reason, now);
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

  claimInputDelivery(
    input: import("../scheduler/ports.js").SchedulerInputDeliveryClaimInput
  ): import("../scheduler/ports.js").SchedulerInputDeliveryClaimResult {
    return this.store.transaction((store) => {
      const mailbox = store.getWorkMailbox(input.target);
      if (mailbox === null) return { status: "empty" };
      if (mailbox.inputDelivery !== null) {
        return { status: "delivery", delivery: mailbox.inputDelivery };
      }
      const pending = pendingLane(mailbox, input.lane);
      if (pending === null) return { status: "empty" };
      const claimed = claimMailboxInputDelivery(mailbox, {
        attemptId: input.attemptId,
        lane: input.lane,
        mode: input.mode,
        owner: input.owner,
        startedAt: input.now.toISOString(),
        executionRef: input.executionRef,
        providerFence: input.providerFence
      });
      if (input.target.kind === "role"
        && input.executionRef.type === "run"
        && input.executionRef.taskId === input.target.taskId) {
        const sessions = store.getTaskRoleSessionSet(input.target.taskId, input.target.roleName);
        const binding = sessions?.providerBinding;
        if (sessions === null || sessions === undefined
          || binding === null || binding === undefined
          || binding.runId !== input.executionRef.id
          || binding.authority.owner !== "controller") {
          throw new Error("Controller does not own the Provider writer authority.");
        }
        const conversation = currentProviderConversation(binding);
        const activation = currentProviderActivation(binding);
        if (input.providerFence === undefined
          || conversation.conversationId !== input.providerFence.conversationId
          || activation?.activationId !== input.providerFence.activationId) {
          throw new Error("Provider input claim carries a stale Conversation/Activation fence.");
        }
        const next = beginProviderTurn(binding, {
          attemptId: input.attemptId,
          authorityEpoch: binding.authority.epoch,
          submittedAt: input.now.toISOString()
        });
        store.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(sessions, next, input.now));
      }
      store.saveWorkMailbox(claimed);
      return { status: "claimed", delivery: claimed.inputDelivery! };
    });
  }

  markInputDeliveryPushed(target: MailboxTarget, attemptId: string, now: Date): boolean {
    return this.store.transaction((store) => {
      const mailbox = store.getWorkMailbox(target);
      if (mailbox?.inputDelivery?.attemptId !== attemptId) return false;
      store.saveWorkMailbox(markMailboxInputDeliveryPushed(mailbox, attemptId, now));
      return true;
    });
  }

  completeInputDelivery(target: MailboxTarget, attemptId: string, now: Date): boolean {
    return this.store.transaction((store) => {
      const mailbox = store.getWorkMailbox(target);
      if (mailbox?.inputDelivery?.attemptId !== attemptId) return false;
      const delivery = mailbox.inputDelivery;
      if (target.kind === "role"
        && delivery.executionRef.type === "run"
        && delivery.executionRef.taskId === target.taskId) {
        store.saveEvent(target.taskId, createTaskEvent(
          store.nextEventId(target.taskId),
          target.taskId,
          "run.input-delivered",
          {
            attemptId: delivery.attemptId,
            runId: delivery.executionRef.id,
            ...(delivery.providerFence === undefined ? {} : {
              conversationId: delivery.providerFence.conversationId,
              activationId: delivery.providerFence.activationId,
              ...(delivery.providerFence.nativeTurnId === undefined ? {} : {
                nativeTurnId: delivery.providerFence.nativeTurnId
              })
            })
          },
          now
        ));
      }
      store.saveWorkMailbox(completeMailboxInputDelivery(mailbox, attemptId, now));
      return true;
    });
  }

  releaseInputDelivery(target: MailboxTarget, attemptId: string, now: Date): boolean {
    return this.store.transaction((store) => {
      const mailbox = store.getWorkMailbox(target);
      if (mailbox?.inputDelivery?.attemptId !== attemptId) return false;
      rejectSubmittingProviderTurn(store, target, mailbox.inputDelivery, now, "Provider write was not attempted.");
      store.saveWorkMailbox(releaseMailboxInputDelivery(mailbox, attemptId));
      return true;
    });
  }

  resolveInputDeliveryNotAccepted(target: MailboxTarget, attemptId: string, now: Date): boolean {
    return this.store.transaction((store) => {
      const mailbox = store.getWorkMailbox(target);
      if (mailbox?.inputDelivery?.attemptId !== attemptId) return false;
      rejectSubmittingProviderTurn(store, target, mailbox.inputDelivery, now, "Provider returned an exact negative acknowledgement.");
      store.saveWorkMailbox(resolveMailboxInputDeliveryNotAccepted(mailbox, attemptId));
      return true;
    });
  }

  markInputDeliveryUnknown(
    target: MailboxTarget,
    attemptId: string,
    reason: string,
    now: Date
  ): boolean {
    return this.store.transaction((store) => {
      const mailbox = store.getWorkMailbox(target);
      if (mailbox?.inputDelivery?.attemptId !== attemptId) return false;
      const unknown = markMailboxInputDeliveryUnknown(mailbox, attemptId, reason, now);
      markSubmittingProviderTurnUnknown(store, target, mailbox.inputDelivery, now, reason);
      store.saveWorkMailbox(unknown);
      const taskId = target.kind === "role" ? target.taskId : undefined;
      if (taskId !== undefined) {
        store.saveEvent(taskId, createTaskEvent(
          store.nextEventId(taskId),
          taskId,
          "run.input-delivery-unknown",
          { attemptId, reason },
          now
        ));
        enqueueWork(store, { kind: "operator" }, "run-input-delivery-unknown", now, [
          unknown.inputDelivery!.executionRef
        ], {
          source: "input-router",
          dedupeKey: `input-delivery-unknown:${attemptId}`,
          deliveryMode: "followup",
          lane: "normal"
        });
      }
      return true;
    });
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
      if (mailbox === null || !hasRuntimeCleanupObligation(mailbox)) return false;
      if (mailbox.processing !== null) {
        if (
          !isRuntimeLaunchReservation(mailbox.processing)
          && !mailbox.processing.batch.reasons.includes(
            RUNTIME_CLEANUP_REQUIRED_REASON
          )
        ) {
          return false;
        }
        mailbox = completeProcessing(mailbox, mailbox.processing.batchId);
      }
      const pending = pendingLane(mailbox, "normal");
      if (pending !== null) {
        if (
          pending.reasons.length !== 1
          || pending.reasons[0] !== RUNTIME_CLEANUP_REQUIRED_REASON
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
      markRuntimeOwnerSessionStopped(store, owner, now);
      if (owner.scope === "task") {
        const sessions = store.getTaskRoleSessionSet(owner.taskId, owner.roleName);
        if (sessions !== null && sessions.providerBinding !== null) {
          store.saveTaskRoleSessionSet(
            clearTaskRoleProviderRuntimeForCleanup(sessions, now)
          );
        }
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
      markRuntimeOwnerSessionStopped(store, runtimeOwnerFromTarget(target), now);
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
          && this.store.getActiveAgentRun(
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
        ...(candidate.launchId === undefined ? {} : { launchId: candidate.launchId }),
        sessionUpdatedAt: candidate.sessionUpdatedAt
      }];
    });
  }

  listRuntimeSessionCandidates(
    query: RuntimeSessionCandidateQuery = {}
  ): readonly RuntimeSessionCandidate[] {
    return this.store.listRuntimeSessionCandidates(query);
  }

  markRuntimeOwnerStopped(
    candidate: DormantRuntimeOwnerCandidate,
    now: Date
  ): boolean {
    return this.store.transaction((store) => {
      if (!dormantRuntimeCandidateIsCurrent(store, candidate)) return false;
      return markRuntimeOwnerSessionStopped(store, candidate.owner, now);
    });
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
  getPendingWakeup(taskId: string) { return this.store.getPendingWakeup(taskId); }
  listPendingWakeups() { return this.store.listPendingWakeups(); }
  savePendingWakeup(wakeup: Parameters<TaskStore["savePendingWakeup"]>[0]): void {
    this.store.savePendingWakeup(wakeup);
  }
  clearPendingWakeup(taskId: string): void { this.store.clearPendingWakeup(taskId); }
  getLeaderFailure(taskId: string) { return this.store.getLeaderFailure(taskId); }
  getOperatorNotification(taskId: string) { return this.store.getOperatorNotification(taskId); }

  saveLeaderDispatch(input: LeaderDispatchPersistence): LeaderDispatchClaimResult {
    return this.store.transaction((store) => {
      const task = store.getTask(input.task.id);
      if (task === null || task.status !== "active") {
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
      if (!isDeepStrictEqual(input.run.effective, input.role.effective)) {
        return "state-changed";
      }
      if (store.getAgentRun(input.task.id, input.run.id) !== null) return "state-changed";
      if (store.getActiveAgentRun(input.task.id, input.role.name) !== null) return "busy";
      const pending = store.getPendingWakeup(input.task.id);
      if (pending === null || !pendingWakeupsMatch(pending, input.wakeup)) {
        return "state-changed";
      }
      const target = { kind: "role", taskId: input.task.id, roleName: input.role.name } as const;
      const mailbox = store.getWorkMailbox(target);
      if (mailbox === null || !mailboxHasPending(mailbox)) return "state-changed";
      if (mailbox.processing !== null) return "busy";
      if (store.peekNextAgentRunId(input.task.id) !== input.run.id) {
        return "state-changed";
      }
      const allocatedRunId = store.nextAgentRunId(input.task.id);
      if (allocatedRunId !== input.run.id) {
        throw new Error(`Leader Run allocation changed unexpectedly: ${input.task.id}.`);
      }
      const batchId = formatAgentRunReceiptId(input.task.id, input.run.id);
      const claimed = bindExecution(
        claimPending(mailbox, {
          batchId,
          owner: "controller",
          startedAt: input.now.toISOString()
        }),
        batchId,
        { type: "run", taskId: input.task.id, id: input.run.id }
      );
      // SQLite stores the durable Run row and its active pointer separately;
      // FileTaskStore happens to persist both from saveActiveAgentRun. Keep
      // the adapter contract backend-neutral and make the two writes atomic.
      store.saveAgentRun(input.run);
      store.saveActiveAgentRun(input.run);
      store.saveWorkMailbox(claimed);
      store.saveRole(input.task.id, updateRoleStatus(role, "running", input.now));
      bindTaskRoleRunInFlight(store, role, input.run, input.now);
      store.saveEvent(input.task.id, createTaskEvent(
        store.nextEventId(input.task.id),
        input.task.id,
        "run.dispatched",
        runLaunchEventPayload(input.run),
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
          runId: input.run.id,
          now: input.now
        }));
      }
      if (input.session !== null && input.session.nativeSessionId !== undefined) {
        saveTaskSession(store, role, {
          ...input.session,
          nativeSessionId: input.session.nativeSessionId
        }, "running", input.now);
      }
      store.clearLeaderFailure(input.task.id);
      store.clearOperatorNotification(input.task.id);
      return "claimed";
    });
  }

  saveRoleRunDelivery(input: RoleRunDeliveryPersistence): void {
    this.store.transaction((store) => {
      const task = store.getTask(input.task.id);
      if (task === null || task.status !== "active") {
        throw new Error(`Task is not active: ${input.task.id}.`);
      }
      const role = requireRole(store, input.task.id, input.role.name);
      const active = store.getActiveAgentRun(input.task.id, input.role.name);
      if (active === null || active.id !== input.run.id) {
        throw new Error(`Active Agent run changed before delivery was persisted: ${input.run.id}.`);
      }
      let deliveryRun = active;
      if (active.providerRetry?.state === "dispatching") {
        deliveryRun = withProviderRetry(
          active,
          markProviderRetryDispatched(active.providerRetry)
        );
        store.saveAgentRun(deliveryRun);
        store.saveEvent(task.id, createTaskEvent(
          store.nextEventId(task.id),
          task.id,
          "runtime.provider-retry-dispatched",
          {
            runId: active.id,
            roleName: active.roleName,
            episodeId: active.providerRetry.episodeId,
            receiptId: active.providerRetry.lastRetryReceiptId ?? "",
            dispatchedRetries: String(active.providerRetry.dispatchedRetries + 1)
          },
          input.now
        ));
      }
      if (active.controlRequest?.state === "dispatching") {
        deliveryRun = {
          ...active,
          controlRequest: markWorkflowOutcomeRequestDispatched(active.controlRequest)
        };
        store.saveAgentRun(deliveryRun);
        store.saveEvent(task.id, createTaskEvent(
          store.nextEventId(task.id),
          task.id,
          "runtime.workflow-outcome-request-dispatched",
          {
            runId: active.id,
            roleName: active.roleName,
            requestId: active.controlRequest.requestId,
            receiptId: active.controlRequest.receiptId,
            nativeTurnId: active.controlRequest.nativeTurnId
          },
          input.now
        ));
      }
      // Transport success records prompt-pushed ONLY. Acceptance (deliveredAt)
      // is written exclusively by an exact provider-accepted fold, never by the
      // transport receipt — that removes the transport-to-delivered false path.
      if (deliveryRun.pushedAt === undefined) {
        const pushed = markAgentRunPushed(deliveryRun, input.now);
        store.saveAgentRun(pushed);
        markTaskRoleRunPushedInFlight(store, role, pushed, input.now);
        store.saveEvent(task.id, createTaskEvent(
          store.nextEventId(task.id),
          task.id,
          "run.pushed",
          runLaunchEventPayload(pushed),
          input.now
        ));
      } else {
        const sessions = store.getTaskRoleSessionSet(input.task.id, input.role.name);
        if (sessions?.inFlight?.runId === input.run.id
          && sessions.inFlight.pushedAt === undefined) {
          markTaskRoleRunPushedInFlight(store, role, deliveryRun, input.now);
        }
      }
      if (role.status !== "running") {
        store.saveRole(input.task.id, updateRoleStatus(role, "running", input.now));
      }
      if (input.session !== null && input.session.nativeSessionId !== undefined) {
        const existing = store.getRoleSession(input.task.id, input.role.name);
        const reservation = matchingPreparedRuntimeReservation(
          store,
          input
        );
        if (
          existing?.agentId !== input.session.agentId
          || existing.adapterId !== input.session.adapterId
          || existing.nativeSessionId !== input.session.nativeSessionId
          || (input.launchId !== undefined && existing.launchId !== input.launchId)
          || existing.status !== "running"
        ) {
          saveTaskSession(store, role, {
            ...input.session,
            nativeSessionId: input.session.nativeSessionId
          }, "running", input.now, input.launchId);
        }
        completePreparedRuntimeReservation(store, reservation);
      }
    });
  }

  saveRoleRunPrepared(input: RoleRunDeliveryPersistence): void {
    this.store.transaction((store) => {
      const task = store.getTask(input.task.id);
      if (task === null || task.status !== "active") {
        throw new Error(`Task is not active: ${input.task.id}.`);
      }
      const role = requireRole(store, input.task.id, input.role.name);
      const active = store.getActiveAgentRun(input.task.id, input.role.name);
      if (active === null || active.id !== input.run.id) {
        throw new Error(`Active Agent run changed before preparation was persisted: ${input.run.id}.`);
      }
      if (input.session !== null && input.session.nativeSessionId !== undefined) {
        const existing = store.getRoleSession(input.task.id, input.role.name);
        matchingPreparedRuntimeReservation(
          store,
          input
        );
        if (existing?.nativeSessionId !== input.session.nativeSessionId
          || (input.launchId !== undefined && existing.launchId !== input.launchId)
          || existing.status !== "running") {
          saveTaskSession(store, role, {
            ...input.session,
            nativeSessionId: input.session.nativeSessionId
          }, "running", input.now, input.launchId);
        }
      }
      bindTaskRoleRunInFlight(store, role, input.run, input.now);
    });
  }

  saveRoleRunDeliveryFailure(
    input: RoleRunDeliveryFailurePersistence
  ): "failed" | "state-changed" {
    return this.store.transaction((store) => {
      const task = store.getTask(input.taskId);
      const role = store.getRole(input.taskId, input.roleName);
      const active = store.getActiveAgentRun(input.taskId, input.roleName);
      const sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName);
      const session = sessions?.sessions[input.agentId];
      const mailbox = store.getWorkMailbox({
        kind: "role",
        taskId: input.taskId,
        roleName: input.roleName
      });
      const runtimeMailbox = store.getWorkMailbox(runtimeLifecycleTarget({
        scope: "task",
        taskId: input.taskId,
        roleName: input.roleName
      }));
      if (
        task === null
        || task.status !== "active"
        || role === null
        || active === null
        || active.id !== input.runId
        || active.status !== "active"
        || active.pushedAt !== undefined
        || active.effective.agentId !== input.agentId
        || active.effective.adapterId !== input.adapterId
        || mailbox?.processing?.batchId !== input.mailboxBatchId
        || mailbox.processing.executionRef?.type !== "run"
        || mailbox.processing.executionRef.taskId !== input.taskId
        || mailbox.processing.executionRef.id !== input.runId
        || !preparedDeliveryFailureSessionFenceMatches(
          sessions,
          session,
          input,
          agentRunDeliveryReceiptId(active)
        )
        || !preparedReservationMatches(
          runtimeMailbox,
          input.taskId,
          input.runId,
          input.launchId
        )
      ) {
        return "state-changed";
      }

      const summary = `Role delivery retry limit exhausted before exact Run input delivery: ${input.runId}.`;
      const result = terminalizeExactTaskRun(store, {
        taskId: input.taskId,
        roleName: input.roleName,
        agentId: input.agentId,
        runId: input.runId,
        receiptId: agentRunDeliveryReceiptId(active),
        ...(session?.nativeSessionId === undefined
          ? {}
          : { nativeSessionId: session.nativeSessionId }),
        ...(input.launchId === undefined ? {} : { launchId: input.launchId }),
        outcome: { status: "failed", summary }
      }, input.now);
      if (result.disposition !== "applied" || result.run === null) {
        return "state-changed";
      }

      enqueueWork(
        store,
        runtimeLifecycleTarget({
          scope: "task",
          taskId: input.taskId,
          roleName: input.roleName
        }),
        RUNTIME_CLEANUP_REQUIRED_REASON,
        input.now,
        [{ type: "task", id: input.taskId }]
      );

      const terminal = result.run;
      store.saveEvent(input.taskId, createTaskEvent(
        store.nextEventId(input.taskId),
        input.taskId,
        "runtime.role-delivery-failed",
        {
          runId: terminal.id,
          roleName: input.roleName,
          outcome: terminal.status
        },
        input.now
      ));

      if (terminal.purpose === "execution" && terminal.workItemId !== undefined) {
        const item = store.getWorkItem(input.taskId, terminal.workItemId);
        if (item !== null && ![
          "completed", "failed", "retired"
        ].includes(item.status)) {
          if (!workItemOwnsUnresolvedExecutionLane(
            item,
            terminal.executionGroupId,
            terminal.executionLaneId
          )) {
            store.saveWorkItem(
              input.taskId,
              updateWorkItemStatus(item, "failed", input.now, summary)
            );
          }
        }
      }

      if (input.roleName !== "leader") {
        enqueueWork(
          store,
          { kind: "role", taskId: input.taskId, roleName: "leader" },
          terminal.purpose === "review" ? "review-failed" : "role-run-failed",
          input.now,
          [
            { type: "run", taskId: input.taskId, id: terminal.id },
            ...(terminal.workItemId === undefined
              ? []
                : [{ type: "work-item" as const, taskId: input.taskId, id: terminal.workItemId }])
          ]
        );
      } else {
        const failedRole = store.getRole(input.taskId, input.roleName);
        if (failedRole !== null) {
          store.saveRole(
            input.taskId,
            updateRoleStatus(failedRole, "failed", input.now)
          );
        }
        store.saveLeaderFailure(recordLeaderFailure(
          input.taskId,
          session?.nativeSessionId ?? "(unregistered)",
          summary,
          input.now,
          store.getLeaderFailure(input.taskId)
        ));
        store.saveOperatorNotification(createLeaderRecoveryNotification(
          input.taskId,
          summary,
          input.now,
          store.getOperatorNotification(input.taskId)
        ));
        enqueueWork(
          store,
          { kind: "operator" },
          "leader-run-failed",
          input.now,
          [
            { type: "task", id: input.taskId },
            { type: "run", taskId: input.taskId, id: terminal.id }
          ]
        );
      }
      return "failed";
    });
  }

  saveLeaderDispatchFailure(
    input: LeaderDispatchFailurePersistence
  ): "failed" | "state-changed" {
    return this.store.transaction((store) => {
      const task = store.getTask(input.task.id);
      const role = store.getRole(input.task.id, input.role.name);
      const active = store.getActiveAgentRun(input.task.id, input.role.name);
      const target = {
        kind: "role",
        taskId: input.task.id,
        roleName: input.role.name
      } as const;
      const mailbox = store.getWorkMailbox(target);
      if (
        task === null
        || task.status !== "active"
        || role === null
        || active === null
        || active.id !== input.claimed.run.id
        || active.status !== "active"
        || mailbox?.processing?.executionRef?.type !== "run"
        || mailbox.processing.executionRef.taskId !== input.task.id
        || mailbox.processing.executionRef.id !== input.claimed.run.id
        || !schedulerRoleSessionsMatch(
          store.getRoleSession(input.task.id, input.role.name),
          input.session
        )
      ) {
        return "state-changed";
      }
      store.saveAgentRun(failAgentRun(active, input.failure.message, input.now));
      store.clearActiveAgentRun(input.task.id, input.role.name);
      clearTaskRoleRunInFlight(store, role, active, input.now);
      store.saveWorkMailbox(releaseProcessing(mailbox, mailbox.processing.batchId));
      store.saveRole(input.task.id, updateRoleStatus(role, "failed", input.now));
      breakTaskSessionIfPresent(
        store,
        input.task.id,
        role.name,
        active.effective.agentId,
        input.now
      );
      const failure = recordLeaderFailure(
        input.task.id,
        input.failure.nativeSessionId,
        input.failure.message,
        input.now,
        store.getLeaderFailure(input.task.id)
      );
      store.saveLeaderFailure(failure);
      store.saveOperatorNotification(createLeaderRecoveryNotification(
        input.task.id,
        input.notification.message,
        input.now,
        store.getOperatorNotification(input.task.id)
      ));
      enqueueWork(store, { kind: "operator" }, "leader-recovery-failed", input.now, [
        { type: "task", id: input.task.id }
      ]);
      return "failed";
    });
  }

  saveExitedRoleRun(input: ExitedRoleRunPersistence): "failed" | "state-changed" {
    return this.store.transaction((store) => {
      const task = store.getTask(input.task.id);
      const role = store.getRole(input.task.id, input.role.name);
      const currentRun = store.getActiveAgentRun(input.task.id, input.role.name);
      if (
        task === null
        || task.status !== "active"
        || role === null
        || currentRun === null
        || currentRun.id !== input.run.id
        || currentRun.status !== "active"
      ) {
        return "state-changed";
      }
      const sessions = store.getTaskRoleSessionSet(task.id, role.name);
      if (
        sessions?.inFlight !== null
        && sessions !== null
        && (
          sessions.inFlight.agentId !== currentRun.effective.agentId
          || sessions.inFlight.runId !== currentRun.id
          || sessions.inFlight.receiptId !== agentRunDeliveryReceiptId(currentRun)
        )
      ) {
        return "state-changed";
      }
      // Review launch failure uses the aggregate exact-terminalization path.
      // It owns mailbox settlement and ReviewRound convergence together, so a
      // pending pre-delivery dispatch cannot be consumed before its Run and
      // Round pass the same immutable identity fences.
      if (currentRun.purpose === "review") {
        if (
          input.run.taskId !== currentRun.taskId
          || input.run.roleName !== currentRun.roleName
          || input.run.purpose !== "review"
          || input.run.reviewRoundId !== currentRun.reviewRoundId
          || input.run.workItemId !== currentRun.workItemId
          || input.run.effective.agentId !== currentRun.effective.agentId
          || input.run.effective.adapterId !== currentRun.effective.adapterId
        ) {
          return "state-changed";
        }
        const terminal = terminalizeExactTaskRun(store, {
          taskId: task.id,
          roleName: role.name,
          agentId: currentRun.effective.agentId,
          runId: currentRun.id,
          receiptId: agentRunDeliveryReceiptId(currentRun),
          ...(input.session?.nativeSessionId === undefined
            ? {}
            : { nativeSessionId: input.session.nativeSessionId }),
          outcome: { status: "failed", summary: input.summary }
        }, input.now);
        if (terminal.disposition !== "applied") return "state-changed";
        clearMatchingLeaderStallAttention(store, task.id, currentRun.id);
        store.saveRole(task.id, updateRoleStatus(role, "exited", input.now));
        stopTaskSessionIfPresent(
          store,
          task.id,
          role.name,
          currentRun.effective.agentId,
          input.now
        );
        queueLeaderWakeup(store, task.id, wakeReason("review-failed"), input.now);
        return "failed";
      }
      const target = { kind: "role", taskId: task.id, roleName: role.name } as const;
      const mailbox = store.getWorkMailbox(target);
      const processing = mailbox?.processing;
      if (mailbox !== null && processing !== null && processing !== undefined) {
        if (
          processing.executionRef === undefined
          || processing.executionRef.type !== "run"
          || processing.executionRef.taskId !== task.id
          || processing.executionRef.id !== currentRun.id
        ) {
          return "state-changed";
        }
      }
      store.saveAgentRun(failAgentRun(currentRun, input.summary, input.now));
      clearMatchingLeaderStallAttention(store, task.id, currentRun.id);
      store.clearActiveAgentRun(task.id, role.name);
      clearTaskRoleRunInFlight(store, role, currentRun, input.now);
      if (mailbox !== null && processing !== null && processing !== undefined) {
        store.saveWorkMailbox(completeProcessing(mailbox, processing.batchId));
      }
      if (currentRun.purpose === "execution" && currentRun.workItemId !== undefined) {
        const workItem = store.getWorkItem(task.id, currentRun.workItemId);
        if (workItem !== null && !["completed", "failed", "retired"].includes(workItem.status)) {
          // Terminalize the bound execution lane in the same transaction that
          // fails the Run. Without this, a scheduler-driven Worker failure
          // leaves the lane "running" behind a "failed" WorkItem, and a later
          // `yui task run retry` is rejected because the lane is not terminal.
          // The lane result and the WorkItem status are two ordered single-step
          // record revisions, matching the aggregate terminalization path.
          if (currentRun.executionGroupId !== undefined
            && currentRun.executionLaneId !== undefined
            && currentWorkItemExecutionGroup(workItem) !== undefined) {
            const group = currentWorkItemExecutionGroup(workItem)!;
            store.saveWorkItem(task.id, updateWorkItemExecutionGroup(
              workItem,
              recordExecutionLaneResult(
                group,
                currentRun.executionLaneId,
                { summary: input.summary },
                "failed",
                input.now
              ),
              input.now
            ));
          }
          const laneUpdated = store.getWorkItem(task.id, currentRun.workItemId)!;
          if (!workItemOwnsUnresolvedExecutionLane(
            laneUpdated,
            currentRun.executionGroupId,
            currentRun.executionLaneId
          )) {
            store.saveWorkItem(
              task.id,
              updateWorkItemStatus(laneUpdated, "failed", input.now, input.summary)
            );
          }
        }
      }
      store.saveRole(task.id, updateRoleStatus(role, "exited", input.now));
      stopTaskSessionIfPresent(
        store,
        task.id,
        role.name,
        currentRun.effective.agentId,
        input.now
      );
      queueLeaderWakeup(
        store,
        task.id,
        wakeReason(role.name === "leader" ? "leader-run-failed" : "role-run-failed"),
        input.now
      );
      return "failed";
    });
  }

  /** Called by the internal Codex notify hook, never by an LLM prompt. */
  recordRuntimeNativeSession(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    launchId?: string;
    nativeSessionId: string;
  }>, now = new Date()): RoleAgentSession {
    return this.store.transaction((store) => (
      recordTaskRuntimeNativeSession(store, input, now)
    ));
  }

  reserveRuntimeLaunch(
    input: Readonly<{ owner: RuntimeRoleOwner; launchId: string; runId?: string }>,
    assertCurrent: () => void,
    now = new Date()
  ): Readonly<{
    status: "reserved" | "existing";
    launchId: string;
    runId?: string;
  }> {
    return this.store.transaction((store) => {
      assertCurrent();
      const target = runtimeLifecycleTarget(input.owner);
      const existing = store.getWorkMailbox(target);
      if (isRuntimeLaunchReservation(existing?.processing)) {
        if (hasRuntimeCleanupObligation(existing)) {
          throw new Error("Runtime cleanup is still pending.");
        }
        const executionRef = existing!.processing!.executionRef;
        if (executionRef?.type === "run"
          && (input.owner.scope !== "task"
            || executionRef.taskId !== input.owner.taskId)) {
          throw new Error("Runtime launch reservation belongs to another Task Run.");
        }
        return {
          status: "existing",
          launchId: existing!.processing!.batchId,
          ...(executionRef?.type === "run"
            ? { runId: executionRef.id }
            : {})
        };
      }
      if (
        existing !== null
        && (existing.processing !== null || existing.pending !== null)
      ) {
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
      if (queued === null || queued.pending === null || queued.processing !== null) {
        throw new Error("Runtime launch reservation could not be queued.");
      }
      let claimed = claimPending(queued, {
        batchId: input.launchId,
        owner: RUNTIME_LIFECYCLE_OWNER,
        startedAt: now.toISOString()
      });
      if (input.runId !== undefined) {
        if (input.owner.scope !== "task") {
          throw new Error("A Run-bound runtime reservation requires a Task owner.");
        }
        claimed = bindExecution(
          claimed,
          input.launchId,
          { type: "run", taskId: input.owner.taskId, id: input.runId }
        );
      }
      store.saveWorkMailbox(claimed);
      return {
        status: "reserved",
        launchId: input.launchId,
        ...(input.runId === undefined ? {} : { runId: input.runId })
      };
    });
  }

  confirmRuntimeLaunchReservation(
    input: Readonly<{ owner: RuntimeRoleOwner; launchId: string }>,
    assertCurrent: () => void
  ): "reserved" | "provider-bound" {
    return this.store.transaction((store) => {
      assertCurrent();
      const mailbox = store.getWorkMailbox(runtimeLifecycleTarget(input.owner));
      if (isRuntimeLaunchReservation(mailbox?.processing, input.launchId)) {
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
        active?.status === "running"
        && active.launchId === input.launchId
      ) return "provider-bound" as const;
      throw new Error("Runtime launch reservation no longer matches the launch.");
    });
  }

  recordReservedRuntimeNativeSession(input: Readonly<{
    owner: RuntimeRoleOwner;
    launchId: string;
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
        input.launchId
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
            launchId: input.launchId,
            effective: input.effective
          }, now)
        : recordGlobalRuntimeNativeSession(store, {
            roleName: input.owner.roleName,
            agentId: input.agentId,
            adapterId: input.adapterId,
            nativeSessionId: input.nativeSessionId,
            launchId: input.launchId,
            effective: input.effective
          }, now);
      saveRuntimeLifecycleMailbox(
        store,
        completeProcessing(mailbox, input.launchId)
      );
      return session;
    });
  }

  completeRuntimeLaunchReservation(
    owner: RuntimeRoleOwner,
    launchId: string,
    expectedTerminalRunId?: string,
    beforeComplete?: () => void
  ): boolean {
    return this.store.transaction((store) => {
      const target = runtimeLifecycleTarget(owner);
      const mailbox = store.getWorkMailbox(target);
      if (!isRuntimeLaunchReservation(mailbox?.processing, launchId)) return false;
      if (expectedTerminalRunId !== undefined) {
        const expectedRun = owner.scope === "task"
          ? store.getAgentRun(owner.taskId, expectedTerminalRunId)
          : null;
        if (
          owner.scope !== "task"
          || mailbox?.processing?.executionRef?.type !== "run"
          || mailbox.processing.executionRef.taskId !== owner.taskId
          || mailbox.processing.executionRef.id !== expectedTerminalRunId
          || expectedRun === null
          || expectedRun.status === "active"
        ) {
          return false;
        }
      }
      beforeComplete?.();
      saveRuntimeLifecycleMailbox(
        store,
        completeProcessing(mailbox!, launchId)
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
   * current and no later lifecycle work or Task Run exists.
   */
  settleStoppedRuntimeLaunch(input: Readonly<{
    owner: RuntimeRoleOwner;
    launchId: string;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
  }>, now = new Date()): boolean {
    return this.store.transaction((store) => {
      const target = runtimeLifecycleTarget(input.owner);
      const mailbox = store.getWorkMailbox(target);
      if (isRuntimeLaunchReservation(mailbox?.processing, input.launchId)) {
        const sessions = runtimeOwnerSessionSet(store, input.owner);
        const active = sessions?.sessions[sessions.activeAgentId];
        if (runtimeSessionMatchesSettledLaunch(active, input)) {
          markRuntimeOwnerSessionStopped(store, input.owner, now);
        }
        saveRuntimeLifecycleMailbox(
          store,
          completeProcessing(mailbox!, input.launchId)
        );
        return true;
      }
      if (hasRuntimeLifecycleWork(mailbox)) return false;
      if (
        input.owner.scope === "task"
        && store.getActiveAgentRun(
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
      if (active.status !== "stopped") {
        markRuntimeOwnerSessionStopped(store, input.owner, now);
      }
      return true;
    });
  }

  /**
   * Fast hook path: validates the native Turn boundary before it is either
   * retained as an intermediate child wait or recorded as a ready boundary
   * for later mailbox input. It never performs tmux, workspace, or Controller I/O.
   */
  classifyRuntimeTurnCompleted(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    launchId?: string;
    nativeSessionId: string;
    turnId: string;
    runId?: string;
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
      && !runtimeHookMatchesReservation(this.store, owner, input.launchId)
    ) return "obsolete";
    try {
      const effectiveExisting = nativeTransitionExisting(
        this.store,
        owner,
        existing,
        input.nativeSessionId,
        input.launchId,
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
    // A normal explicit CLI yield may precede its native Hook; that Hook still
    // owns the turn fact. A forced cleanup boundary or stopped process instead
    // makes the old generation obsolete.
    if (sessions?.inFlight === null || sessions === null) {
      const cleanup = hasRuntimeCleanupObligation(this.store.getWorkMailbox(
        runtimeLifecycleTarget({
          scope: "task",
          taskId: input.taskId,
          roleName: input.roleName
        })
      ));
      return cleanup || isObsoleteTerminalRuntimeRun(this.store, input)
        ? "obsolete"
        : "apply";
    }
    if (input.runId === undefined || sessions.inFlight.runId !== input.runId) {
      return "obsolete";
    }
    // Provider completion is not a transport acknowledgement. Retain the
    // immutable Hook until the exact pane receipt independently reconciles
    // run.pushed; never infer transport from Driver activity/terminal facts.
    return sessions.inFlight.pushedAt === undefined ? "deferred" : "apply";
  }

  observeRuntimeTurnCompleted(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    launchId?: string;
    nativeSessionId: string;
    turnId: string;
    runId?: string;
    summary: string;
    providerStatus?: "completed" | "failed" | "cancelled";
  }>, now = new Date()): Readonly<{
    session: RoleAgentSession;
    duplicate: boolean;
    disposition?: "obsolete";
  }> {
    return this.store.transaction((store) => {
      const task = store.getTask(input.taskId);
      if (task === null) throw new Error(`Task not found: ${input.taskId}.`);
      if (task.status !== "active") {
        throw new Error(`Cannot complete a runtime turn for inactive Task: ${input.taskId}.`);
      }
      const role = requireRole(store, input.taskId, input.roleName);
      let sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName)
        ?? createRoleSessionSet(
          { scope: "task", taskId: input.taskId, roleName: input.roleName },
          input.agentId,
          now
        );
      const existing = sessions.sessions[input.agentId];
      const owner = {
        scope: "task" as const,
        taskId: input.taskId,
        roleName: input.roleName
      };
      if (
        existing === undefined
        && !runtimeHookMatchesReservation(store, owner, input.launchId)
      ) {
        throw new Error("Runtime turn completion does not match the launch reservation.");
      }
      const effectiveExisting = nativeTransitionExisting(
        store,
        owner,
        existing,
        input.nativeSessionId,
        input.launchId,
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
        throw new Error("Runtime turn completion does not match the effective launch identity.");
      }
      if (effectiveExisting !== undefined
        && hasRecentTurnId(effectiveExisting.recentCompletedTurnIds, input.turnId)) {
        return { session: effectiveExisting, duplicate: true };
      }
      if (sessions.inFlight === null
        && existing !== undefined
        && (
          hasRuntimeCleanupObligation(store.getWorkMailbox(runtimeLifecycleTarget(owner)))
          || isObsoleteTerminalRuntimeRun(store, input)
        )) {
        return { session: existing, duplicate: false, disposition: "obsolete" };
      }
      // Classification is only an optimization. Revalidate the Run inside the
      // authoritative transaction before a Hook may claim a native identity.
      if (
        sessions.inFlight !== null
        && (
          input.runId === undefined
          || sessions.inFlight.runId !== input.runId
        )
      ) {
        if (effectiveExisting === undefined) {
          throw new Error("Runtime turn completion no longer matches the in-flight Run.");
        }
        return { session: effectiveExisting, duplicate: false };
      }
      if (sessions.inFlight !== null && sessions.inFlight.pushedAt === undefined) {
        throw new Error(
          "Runtime turn completion requires an independently committed transport receipt."
        );
      }
      const idleStatus = effectiveExisting?.status === "stopped"
        || effectiveExisting?.status === "broken"
        ? effectiveExisting.status
        : "ready";
      sessions = recordRoleAgentSession(sessions, {
        agentId: input.agentId,
        adapterId: input.adapterId,
        nativeSessionId: input.nativeSessionId,
        ...(input.launchId === undefined ? {} : { launchId: input.launchId }),
        policy: "fixed",
        status: idleStatus === "stopped" || idleStatus === "broken"
          ? idleStatus
          : sessions.inFlight === null ? idleStatus : "running",
        effective
      }, now);
      sessions = settleStructuredProviderTurn(
        sessions,
        input.turnId,
        input.providerStatus ?? "completed",
        now
      );
      if (sessions.inFlight === null) {
        sessions = rememberRoleAgentCompletedTurn(
          sessions,
          input.agentId,
          input.nativeSessionId,
          input.turnId,
          now
        );
        store.saveTaskRoleSessionSet(sessions);
        completeRuntimeHookReservation(store, owner, input.launchId);
        // The in-flight fence was cleared by an in-place provider retry
        // decision. If the active Run is still in its retry window and this
        // completion belongs to it, the recovered CLI finished the original
        // turn: clear the retry projection so the deadline does not re-push
        // the prompt. The Run stays active for the normal completion path.
        const activeRun = store.getActiveAgentRun(task.id, role.name);
        if (
          activeRun !== null
          && activeRun.providerRetry !== undefined
          && input.runId === activeRun.id
        ) {
          const { providerRetry: _removed, ...rest } = activeRun;
          store.saveAgentRun({ ...rest, updatedAt: now.toISOString() });
        }
        return { session: sessions.sessions[input.agentId]!, duplicate: false };
      }

      // A provider Turn is an activation boundary, not a Yui Run outcome.
      // Preserve the Run fence and make the fixed native Session available for
      // a later mailbox batch.  Provider-owned background subagents may finish
      // after this point and Yui must not invent a failure while waiting.
      sessions = recordTaskRoleTurnBoundary(sessions, {
        agentId: input.agentId,
        nativeSessionId: input.nativeSessionId,
        turnId: input.turnId
      }, now);
      store.saveTaskRoleSessionSet(sessions);
      completeRuntimeHookReservation(store, owner, input.launchId);
      return {
        session: sessions.sessions[input.agentId]!,
        duplicate: false
      };
    });
  }

  classifyRuntimeTurnFailed(
    input: TaskRuntimeTurnFailed
  ): "apply" | "obsolete" {
    const task = this.store.getTask(input.taskId);
    if (task?.status !== "active") return "obsolete";
    const role = this.store.getRole(input.taskId, input.roleName);
    if (role === null) return "obsolete";
    const run = this.store.getAgentRun(input.taskId, input.runId);
    const active = this.store.getActiveAgentRun(input.taskId, input.roleName);
    if (
      run === null
      || run.status !== "active"
      || active?.id !== run.id
      || run.roleName !== input.roleName
      || run.effective.agentId !== input.agentId
      || run.effective.adapterId !== input.adapterId
    ) return "obsolete";
    const sessions = this.store.getTaskRoleSessionSet(input.taskId, input.roleName);
    const session = sessions?.sessions[input.agentId];
    if (
      sessions === null
      || session?.nativeSessionId !== input.nativeSessionId
      || session.launchId !== input.launchId
      || sessions.inFlight?.agentId !== input.agentId
      || sessions.inFlight.runId !== input.runId
      || sessions.inFlight.receiptId !== agentRunDeliveryReceiptId(run)
    ) return "obsolete";
    return "apply";
  }

  observeRuntimeTurnFailed(
    input: TaskRuntimeTurnFailed,
    now = new Date()
  ): Readonly<{ disposition: "applied" | "obsolete"; runId: string }> {
    return this.store.transaction((store) => {
      const before = store.getAgentRun(input.taskId, input.runId);
      if (before === null) {
        recordObsoleteRuntimeEvent(store, input, "run-missing", now);
        return { disposition: "obsolete", runId: input.runId };
      }
      const summary = runtimeTurnFailureSummary(input);
      // Issue 04: a classified transient Provider failure keeps the exact Run
      // and Native Session and is retried in place instead of terminalizing.
      const retryDecision = this.providerRetryDecision(store, input, summary, now);
      if (retryDecision !== null) return retryDecision;
      const result = terminalizeExactTaskRun(store, {
        taskId: input.taskId,
        roleName: input.roleName,
        agentId: input.agentId,
        runId: input.runId,
        receiptId: agentRunDeliveryReceiptId(before),
        nativeSessionId: input.nativeSessionId,
        launchId: input.launchId,
        outcome: {
          status: "failed",
          summary
        }
      }, now);
      if (result.disposition === "obsolete" || result.run === null) {
        recordObsoleteRuntimeEvent(
          store,
          input,
          result.reason ?? "identity-mismatch-or-terminal",
          now
        );
        return { disposition: "obsolete", runId: input.runId };
      }

      enqueueWork(
        store,
        runtimeLifecycleTarget({
          scope: "task",
          taskId: input.taskId,
          roleName: input.roleName
        }),
        RUNTIME_CLEANUP_REQUIRED_REASON,
        now,
        [{ type: "task", id: input.taskId }]
      );

      const terminal = result.run;

      if (before.purpose === "execution" && before.workItemId !== undefined) {
        const item = store.getWorkItem(input.taskId, before.workItemId);
        if (item !== null && ![
          "completed", "failed", "retired"
        ].includes(item.status) && !workItemOwnsUnresolvedExecutionLane(
          item,
          before.executionGroupId,
          before.executionLaneId
        )) {
          store.saveWorkItem(
            input.taskId,
            updateWorkItemStatus(item, "failed", now, summary)
          );
        }
      }
      const role = store.getRole(input.taskId, input.roleName);
      if (role !== null) {
        store.saveRole(
          input.taskId,
          updateRoleStatus(role, input.roleName === "leader" ? "failed" : "idle", now)
        );
      }

      store.saveEvent(input.taskId, createTaskEvent(
        store.nextEventId(input.taskId),
        input.taskId,
        "runtime.turn-failed",
        {
          eventId: input.eventId,
          runId: input.runId,
          roleName: input.roleName,
          outcome: terminal.status
        },
        now
      ));

      if (input.roleName !== "leader") {
        enqueueWork(
          store,
          { kind: "role", taskId: input.taskId, roleName: "leader" },
          before.purpose === "review" ? "review-failed" : "role-run-failed",
          now,
          [
            { type: "run", taskId: input.taskId, id: terminal.id },
            ...(terminal.workItemId === undefined
              ? []
              : [{ type: "work-item" as const, taskId: input.taskId, id: terminal.workItemId }])
          ]
        );
      } else {
        store.saveOperatorNotification(createLeaderRecoveryNotification(
          input.taskId,
          summary,
          now,
          store.getOperatorNotification(input.taskId)
        ));
        enqueueWork(
          store,
          { kind: "operator" },
          "leader-run-failed",
          now,
          [
            { type: "task", id: input.taskId },
            { type: "run", taskId: input.taskId, id: terminal.id }
          ]
        );
      }
      return { disposition: "applied", runId: input.runId };
    });
  }

  /**
   * Issue 04 in-place retry decision for one classified Provider failure.
   * Returns an observation when the failure was handled without terminalizing
   * the Run, or `null` to fall through to the existing terminalization path.
   */
  private providerRetryDecision(
    store: TaskStore,
    input: TaskRuntimeTurnFailed,
    summary: string,
    now: Date
  ): Readonly<{ disposition: "applied"; runId: string }> | null {
    const config = providerRetryConfig(this.store.getConfig());
    if (config.mode === "off") return null;
    const classification = classifyProviderError({
      adapterId: input.adapterId,
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      error: input.error,
      errorDetails: input.errorDetails,
      summary: input.lastAssistantMessage
    });
    const adapterEnabled = providerRetryAdapterEnabled(config, input.adapterId);
    const retryable = adapterEnabled
      && isRetryableProviderErrorClass(classification.errorClass);
    const shadow = config.mode === "shadow";

    // Shadow mode records the classification and "would retry" fact without
    // changing any behavior; the Run still terminalizes below.
    if (shadow || !retryable) {
      if (adapterEnabled) {
    this.recordProviderRetryClassified(store, input, classification.errorClass, {
          wouldRetry: String(retryable),
          basis: classification.basis,
          shadow: String(shadow)
        }, now);
      }
      if (!shadow && classification.errorClass === "policy-denied") {
        const blocked = this.applyProviderPolicyBlock(store, input, summary, now);
        if (blocked !== null) return blocked;
      }
      if (!shadow && classification.errorClass === "context-capacity") {
        const blocked = this.applyContextCapacityBlock(store, input, summary, now);
        if (blocked !== null) return blocked;
      }
      if (!shadow && classification.errorClass === "session-dead") {
        const run = store.getAgentRun(input.taskId, input.runId);
        if (run !== null && run.status === "active" && run.mode === "resume") {
          // A structured failure on the exact resume launch is the only Core
          // evidence that native continuation is unrecoverable. The normal
          // terminal path below may now request a fresh managed generation.
          store.saveEvent(input.taskId, createTaskEvent(
            store.nextEventId(input.taskId),
            input.taskId,
            "runtime.native-resume-unrecoverable",
            {
              eventId: input.eventId,
              runId: input.runId,
              roleName: input.roleName,
              launchId: input.launchId,
              nativeSessionId: input.nativeSessionId,
              ...(run.assignment.contextSnapshotRef === undefined
                ? {}
                : {
                    contextSnapshotId: run.assignment.contextSnapshotRef.id,
                    contextSnapshotDigest: run.assignment.contextSnapshotRef.digest
                  })
            },
            now
          ));
        } else {
          const blocked = this.applyNativeSessionRecoverabilityBlock(
            store,
            input,
            summary,
            now
          );
          if (blocked !== null) return blocked;
        }
      }
      return null;
    }

    // transport-uncertain: the Provider may have accepted the turn. If a
    // native completion is already durable, the completion path owns the
    // yield; do not resend.
    if (classification.errorClass === "transport-uncertain") {
      const driver = this.drivers.requireByAdapterId(input.adapterId);
      if (driver.capabilities.lifecycle.deliveryDeduplication !== "exact") {
        const run = store.getAgentRun(input.taskId, input.runId);
        if (run === null || run.status !== "active") return null;
        const blocked = scheduleProviderRetry(run.providerRetry, {
          failureEventId: input.eventId,
          errorClass: classification.errorClass,
          launchId: input.launchId,
          nativeSessionId: input.nativeSessionId,
          failedNativeTurnId: input.nativeTurnId,
          lastErrorSummary: summary,
          scheduleNextAttempt: false
        }, now, configuredProviderRetryPolicy(store));
        if (blocked.outcome === "exhausted") return null;
        store.saveAgentRun(withProviderRetry(run, blocked.retry));
        this.recordProviderRetryClassified(store, input, classification.errorClass, {
          wouldRetry: "false",
          shadow: "false",
          note: "delivery-deduplication-unproven"
        }, now);
        enqueueWork(
          store,
          input.roleName === "leader"
            ? { kind: "operator" }
            : { kind: "role", taskId: input.taskId, roleName: "leader" },
          "provider-delivery-uncertain",
          now,
          [{ type: "run", taskId: input.taskId, id: input.runId }]
        );
        return { disposition: "applied", runId: input.runId };
      }
    }

    const run = store.getAgentRun(input.taskId, input.runId);
    if (run === null || run.status !== "active") return null;
    const retryDecision = scheduleProviderRetry(run.providerRetry, {
      failureEventId: input.eventId,
      errorClass: classification.errorClass,
      launchId: input.launchId,
      nativeSessionId: input.nativeSessionId,
      failedNativeTurnId: input.nativeTurnId,
      lastErrorSummary: summary,
      ...(input.retryAfterMs === undefined ? {} : { retryAfterMs: input.retryAfterMs })
    }, now, configuredProviderRetryPolicy(store));
    if (retryDecision.outcome === "exhausted") {
      this.recordProviderRetryClassified(store, input, classification.errorClass, {
        wouldRetry: "false",
        shadow: "false",
        note: `episode-exhausted-${retryDecision.reason}`,
        consecutiveFailures: String(run.providerRetry?.consecutiveFailures ?? 0),
        dispatchedRetries: String(run.providerRetry?.dispatchedRetries ?? 0)
      }, now);
      if (run.providerRetry === undefined) return null;
      const finalized = finalizeProviderRetryDeadline(
        store,
        run,
        retryDecision.reason === "attempts"
          ? `Provider retry failed after all ${run.providerRetry.maxRetries} in-Session continuation attempts.`
          : retryDecision.reason === "retry-after-window"
            ? `Provider Retry-After exceeded the bounded ${config.maxWindowMs / 1_000}-second episode window.`
            : `Provider retry did not recover within the bounded ${config.maxWindowMs / 1_000}-second episode window.`,
        retryDecision.reason === "attempts" ? "attempts-exhausted" : "episode-window-exhausted",
        now
      );
      return finalized ? { disposition: "applied", runId: input.runId } : null;
    }
    const retry = retryDecision.retry;
    store.saveAgentRun(withProviderRetry(run, retry));

    // The in-flight fence and Provider Conversation stay bound while the
    // retry waits. resolveDueProviderRetries advances only the delivery
    // receipt immediately before the exact redispatch.
    // Settle the delivery claim so the retry push can re-claim the mailbox.
    const target = runtimeLifecycleTarget({
      scope: "task",
      taskId: input.taskId,
      roleName: input.roleName
    });
    const mailbox = store.getWorkMailbox(target);
    if (mailbox !== null && mailbox.processing !== null) {
      const settled = completeProcessing(mailbox, mailbox.processing.batchId);
      if (settled.processing === null && settled.pending === null) {
        store.removeWorkMailbox(target);
      } else {
        store.saveWorkMailbox(settled);
      }
    }
    this.recordProviderRetryClassified(store, input, classification.errorClass, {
      wouldRetry: "true",
      shadow: "false",
      consecutiveFailures: String(retry.consecutiveFailures),
      dispatchedRetries: String(retry.dispatchedRetries),
      nextAttemptAt: retry.nextAttemptAt
    }, now);
    return { disposition: "applied", runId: input.runId };
  }

  /**
   * Issue 04 policy-denied handling: the Run stays active on its original
   * Session, no retry is scheduled, and the Leader receives a bounded blocker.
   * Yui never works around a policy denial by switching Session or widening
   * permission.
   */
  private applyProviderPolicyBlock(
    store: TaskStore,
    input: TaskRuntimeTurnFailed,
    summary: string,
    now: Date
  ): Readonly<{ disposition: "applied"; runId: string }> | null {
    const run = store.getAgentRun(input.taskId, input.runId);
    if (run === null || run.status !== "active") return null;
    const retryDecision = scheduleProviderRetry(run.providerRetry, {
      failureEventId: input.eventId,
      errorClass: "policy-denied",
      launchId: input.launchId,
      nativeSessionId: input.nativeSessionId,
      failedNativeTurnId: input.nativeTurnId,
      lastErrorSummary: summary,
      scheduleNextAttempt: false
    }, now, configuredProviderRetryPolicy(store));
    if (retryDecision.outcome === "exhausted") return null;
    store.saveAgentRun(withProviderRetry(run, retryDecision.retry));
    this.recordProviderRetryClassified(store, input, "policy-denied", {
      wouldRetry: "false",
      shadow: "false",
      note: "policy-denied-blocker"
    }, now);
    if (input.roleName !== "leader") {
      enqueueWork(
        store,
        { kind: "role", taskId: input.taskId, roleName: "leader" },
        "provider-policy-blocked",
        now,
        [{ type: "run", taskId: input.taskId, id: input.runId }]
      );
    } else {
      const message = `Leader Run ${input.runId} is blocked by Provider policy: ${summary}`;
      store.saveOperatorNotification(createLeaderRecoveryNotification(
        input.taskId,
        message,
        now,
        store.getOperatorNotification(input.taskId)
      ));
      enqueueWork(
        store,
        { kind: "operator" },
        "leader-provider-policy-blocked",
        now,
        [
          { type: "task", id: input.taskId },
          { type: "run", taskId: input.taskId, id: input.runId }
        ]
      );
    }
    return { disposition: "applied", runId: input.runId };
  }

  /**
   * Exact Provider capacity failures never trigger a token-threshold rollover.
   * Keep the native lineage intact and surface the Driver's explicit native
   * compaction/resume capability; unsupported/unknown capabilities fail safe
   * for Leader/Operator action instead of forcing a fresh generation.
   */
  private applyContextCapacityBlock(
    store: TaskStore,
    input: TaskRuntimeTurnFailed,
    summary: string,
    now: Date
  ): Readonly<{ disposition: "applied"; runId: string }> | null {
    const run = store.getAgentRun(input.taskId, input.runId);
    if (run === null || run.status !== "active") return null;
    const decision = scheduleProviderRetry(run.providerRetry, {
      failureEventId: input.eventId,
      errorClass: "context-capacity",
      launchId: input.launchId,
      nativeSessionId: input.nativeSessionId,
      failedNativeTurnId: input.nativeTurnId,
      lastErrorSummary: summary,
      scheduleNextAttempt: false
    }, now, configuredProviderRetryPolicy(store));
    if (decision.outcome === "exhausted") return null;
    store.saveAgentRun(withProviderRetry(run, decision.retry));
    const driver = this.drivers.requireByAdapterId(input.adapterId);
    store.saveEvent(input.taskId, createTaskEvent(
      store.nextEventId(input.taskId),
      input.taskId,
      "runtime.context-capacity-failure",
      {
        eventId: input.eventId,
        runId: input.runId,
        roleName: input.roleName,
        nativeSessionId: input.nativeSessionId,
        launchId: input.launchId,
        compactionCapability: driver.capabilities.lifecycle.compaction,
        nativeResumeCapability: driver.capabilities.lifecycle.nativeConversationResume,
        action: driver.capabilities.lifecycle.compaction === "native-explicit"
          ? "native-explicit-compaction-required"
          : "await-provider-native-recovery"
      },
      now
    ));
    this.recordProviderRetryClassified(store, input, "context-capacity", {
      wouldRetry: "false",
      shadow: "false",
      note: "provider-native-capacity-recovery-only"
    }, now);
    enqueueWork(
      store,
      input.roleName === "leader"
        ? { kind: "operator" }
        : { kind: "role", taskId: input.taskId, roleName: "leader" },
      "provider-context-capacity-recovery-required",
      now,
      [{ type: "run", taskId: input.taskId, id: input.runId }]
    );
    return { disposition: "applied", runId: input.runId };
  }

  private applyNativeSessionRecoverabilityBlock(
    store: TaskStore,
    input: TaskRuntimeTurnFailed,
    summary: string,
    now: Date
  ): Readonly<{ disposition: "applied"; runId: string }> | null {
    const run = store.getAgentRun(input.taskId, input.runId);
    if (run === null || run.status !== "active") return null;
    const decision = scheduleProviderRetry(run.providerRetry, {
      failureEventId: input.eventId,
      errorClass: "session-dead",
      launchId: input.launchId,
      nativeSessionId: input.nativeSessionId,
      failedNativeTurnId: input.nativeTurnId,
      lastErrorSummary: summary,
      scheduleNextAttempt: false
    }, now, configuredProviderRetryPolicy(store));
    if (decision.outcome === "exhausted") return null;
    store.saveAgentRun(withProviderRetry(run, decision.retry));
    store.saveEvent(input.taskId, createTaskEvent(
      store.nextEventId(input.taskId),
      input.taskId,
      "runtime.native-session-recoverability-unproven",
      {
        eventId: input.eventId,
        runId: input.runId,
        roleName: input.roleName,
        launchId: input.launchId,
        nativeSessionId: input.nativeSessionId,
        requiredEvidence: "exact-native-resume-outcome"
      },
      now
    ));
    enqueueWork(
      store,
      input.roleName === "leader"
        ? { kind: "operator" }
        : { kind: "role", taskId: input.taskId, roleName: "leader" },
      "native-session-recoverability-unproven",
      now,
      [{ type: "run", taskId: input.taskId, id: input.runId }]
    );
    return { disposition: "applied", runId: input.runId };
  }

  private recordProviderRetryClassified(
    store: TaskStore,
    input: TaskRuntimeTurnFailed,
    errorClass: string,
    extra: Readonly<Record<string, string | undefined>>,
    now: Date
  ): void {
    store.saveEvent(input.taskId, createTaskEvent(
      store.nextEventId(input.taskId),
      input.taskId,
      "runtime.provider-retry-classified",
      {
        eventId: input.eventId,
        runId: input.runId,
        roleName: input.roleName,
        errorClass,
        ...extra
      },
      now
    ));
  }

  /**
   * Issue 04 durable retry timer: lists active Runs whose in-place retry is
   * due. The Controller arms its deadline timer from this projection, so a
   * Controller restart resumes the same attempt lineage.
   */
  listPendingProviderRetries(
    taskIds?: readonly string[]
  ): ReadonlyArray<PendingProviderRetry> {
    return this.store.listPendingProviderRetries(taskIds);
  }

  saveRoleHostExitObservation(input: Readonly<{
    taskId: string;
    roleName: string;
    runId: string;
    launchId?: string;
    nativeSessionId?: string;
    deadStatus?: number;
    observedAt: Date;
  }>): void {
    this.store.transaction((store) => {
      const identity = [
        input.taskId,
        input.roleName,
        input.runId,
        input.launchId ?? "unknown-launch",
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
        && (input.launchId === undefined || event.payload.launchId === input.launchId)
        && ["stop-requested", "graceful-stop", "forced-stop", "stop-confirmed"]
          .includes(event.payload.outcome ?? "")
      ));
      const observation = validateRuntimeProcessExitObservation({
        schemaVersion: 1,
        observationId,
        hostSequence: 1,
        hostInstanceId: `tmux-${input.launchId ?? input.roleName}`,
        taskId: input.taskId,
        roleName: input.roleName,
        runId: input.runId,
        launchId: input.launchId ?? `unknown-${input.runId}`,
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
          launchId: observation.launchId,
          observedAt: observation.observedAt,
          classification,
          observation: JSON.stringify(observation)
        },
        input.observedAt
      ));
    });
  }

  /**
   * Issue 04: reopens each due retry on its original Native Session. A Run
   * whose Session is proven dead terminalizes with an exact replacement
   * blocker; a live Session is reset for the existing delivery path, which
   * re-pushes the exact same input in the same pass.
   */
  resolveDueProviderRetries(
    now: Date,
    taskIds?: ReadonlySet<string>
  ): readonly string[] {
    const selectedTaskIds = taskIds === undefined
      ? undefined
      : [...taskIds].sort((left, right) => (
          left.localeCompare(right, undefined, { numeric: true })
        ));
    const due = this.listPendingProviderRetries(selectedTaskIds).filter(
      (entry) => Date.parse(entry.dueAt) <= now.getTime()
    );
    const reopened: string[] = [];
    for (const entry of due) {
      this.store.transaction((store) => {
        const run = store.getAgentRun(entry.taskId, entry.runId);
        if (run === null
          || run.status !== "active"
          || run.providerRetry === undefined) {
          return;
        }
        if (run.providerRetry.state === "dispatching"
          || run.providerRetry.state === "awaiting-progress") {
          if (now.getTime() < Date.parse(run.providerRetry.episodeDeadlineAt)) return;
          finalizeProviderRetryDeadline(
            store,
            run,
            run.providerRetry.state === "dispatching"
              ? "Provider retry delivery outcome remained uncertain through the bounded episode deadline; no correlated Provider progress was observed."
              : "Provider retry produced no correlated Provider input/output progress before the bounded episode deadline.",
            run.providerRetry.state === "dispatching"
              ? "retry-delivery-outcome-uncertain"
              : "provider-progress-timeout",
            now
          );
          return;
        }
        if (run.providerRetry.state !== "scheduled"
          || run.providerRetry.nextAttemptAt === undefined
          || !providerRetryIsDue(run.providerRetry, now)) {
          return;
        }
        let sessions = store.getTaskRoleSessionSet(entry.taskId, entry.roleName);
        const providerBinding = sessions?.providerBinding;
        let recoveryMode: "new" | "resume" = "resume";
        if (providerBinding === null || providerBinding === undefined) {
          deferUnprovenProviderRecovery(
            store,
            run,
            entry.roleName,
            "Provider Conversation identity is missing; automatic recovery is fenced.",
            now
          );
          return;
        }
        const conversation = currentProviderConversation(providerBinding);
        const roleMailbox = store.getWorkMailbox({
          kind: "role",
          taskId: entry.taskId,
          roleName: entry.roleName
        });
        const activeTurnId = providerBinding.turn !== null
          && ["accepted", "running"].includes(providerBinding.turn.status)
          ? providerBinding.turn.turnId
          : undefined;
        const recovery = decideProviderRecovery({
          binding: providerBinding,
          probe: {
            state: conversation.recoverability === "recoverable"
              ? "exists"
              : conversation.recoverability === "unrecoverable" ? "missing" : "unknown",
            conversationId: conversation.conversationId,
            ...(activeTurnId === undefined ? {} : { activeTurnId })
          },
          unsettledInputDelivery: roleMailbox?.inputDelivery != null
        });
        if (recovery.action === "attention") {
          deferUnprovenProviderRecovery(
            store,
            run,
            entry.roleName,
            recovery.reason,
            now
          );
          return;
        }
        if (recovery.action === "observe-active-turn") {
          const deferred = deferProviderRetry(run.providerRetry, now);
          if (deferred === null) {
            finalizeProviderRetryDeadline(
              store,
              run,
              `Provider Turn ${recovery.turnId} remained active through the bounded recovery deadline.`,
              "provider-progress-timeout",
              now
            );
          } else {
            store.saveAgentRun(withProviderRetry(run, deferred));
          }
          return;
        }
        if (recovery.action === "replace") {
          if (conversation.recoverability !== "unrecoverable") {
            deferUnprovenProviderRecovery(
              store,
              run,
              entry.roleName,
              "Provider replacement lacks an exact missing-Conversation observation.",
              now
            );
            return;
          }
          recoveryMode = "new";
          const currentSession = sessions?.sessions[run.effective.agentId];
          if (sessions !== null && currentSession !== undefined
            && currentSession.status !== "broken") {
            sessions = updateRoleAgentSessionStatus(
              sessions,
              run.effective.agentId,
              "broken",
              now
            );
            store.saveTaskRoleSessionSet(sessions);
          }
        }
        const session = sessions?.sessions[run.effective.agentId];
        const identityMatches = session !== undefined
          && session.adapterId === run.effective.adapterId
          && (run.providerRetry.nativeSessionId === undefined
            || session.nativeSessionId === run.providerRetry.nativeSessionId)
          && (run.providerRetry.launchId === undefined
            || session.launchId === run.providerRetry.launchId);
        if (!identityMatches || session?.nativeSessionId === undefined) {
          // Local Session projection loss is not native-session-dead evidence.
          // Preserve the Run and episode for explicit same-generation recovery;
          // only an exact Provider-native resume response may terminalize it as
          // unrecoverable.
          const deferred = deferProviderRetry(run.providerRetry, now);
          if (deferred === null) {
            finalizeProviderRetryDeadline(
              store,
              run,
              "Provider retry safety could not be re-established before the bounded episode deadline; native Session recoverability remains unproven.",
              "native-resume-unproven",
              now
            );
            return;
          }
          store.saveAgentRun(withProviderRetry(run, deferred));
          if (!store.listEvents(entry.taskId).some((event) => (
            event.type === "runtime.provider-retry-native-resume-unproven"
            && event.payload.runId === run.id
          ))) {
            store.saveEvent(entry.taskId, createTaskEvent(
              store.nextEventId(entry.taskId),
              entry.taskId,
              "runtime.provider-retry-native-resume-unproven",
              {
                runId: run.id,
                consecutiveFailures: String(run.providerRetry.consecutiveFailures),
                dispatchedRetries: String(run.providerRetry.dispatchedRetries)
              },
              now
            ));
          }
          enqueueWork(
            store,
            { kind: "operator" },
            "provider-retry-native-resume-unproven",
            now,
            [
              { type: "task", id: entry.taskId },
              { type: "run", taskId: entry.taskId, id: run.id }
            ]
          );
          return;
        }
        if (hasUnsettledRuntimeOperations(store, entry.taskId, run.id)) {
          const deferred = deferProviderRetry(run.providerRetry, now);
          if (deferred === null) {
            finalizeProviderRetryDeadline(
              store,
              run,
              "Provider retry stopped because tool/subagent outcome remained uncertain through the bounded episode deadline.",
              "operation-outcome-uncertain",
              now
            );
            return;
          }
          store.saveAgentRun(withProviderRetry(run, deferred));
          return;
        }
        // Reopen the Run on its original Session: reset transport markers,
        // switch to resume, and mark the projection in-flight. The delivery
        // pass re-pushes the exact same input in this same pass.
        const reopenedRun = reopenRunForProviderRetry(
          run,
          `provider-retry-${run.providerRetry.episodeId}-${run.providerRetry.dispatchedRetries + 1}`,
          now,
          recoveryMode
        );
        store.saveAgentRun(reopenedRun);
        if (sessions !== null && sessions.inFlight !== null) {
          store.saveTaskRoleSessionSet(prepareTaskRoleRunRedispatch(sessions, {
            agentId: run.effective.agentId,
            runId: run.id,
            receiptId: agentRunDeliveryReceiptId(reopenedRun)
          }, now));
        }
        // The retry decision settled the original delivery claim; re-queue the
        // Role mailbox so the delivery pass can claim and re-push the Run.
        enqueueWork(
          store,
          { kind: "role", taskId: entry.taskId, roleName: entry.roleName },
          "provider-retry-repush",
          now,
          [{ type: "run", taskId: entry.taskId, id: run.id }]
        );
        reopened.push(formatTaskRecordReference(entry.taskId, run.id, "agentRun"));
      });
    }
    return reopened;
  }

  /**
   * Applies already-normalized Session observations. Driver-specific startup
   * names and source variants have terminated before this boundary.
   */
  private observeProviderRuntimeIdentity(
    input: RuntimeObservation,
    now: Date
  ): ProviderLifecycleObservation {
    return this.store.transaction((store) => {
      const taskId = input.fence.taskId!;
      const sessions = store.getTaskRoleSessionSet(taskId, input.fence.roleName);
      const run = store.getAgentRun(taskId, input.fence.runId!);
      if (sessions === null || sessions.providerBinding === null || run === null
        || sessions.providerBinding.runId !== input.fence.runId
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
            const run = store.getAgentRun(taskId, input.fence.runId!);
            if (role === null || sessions === null || run === null) {
              recordCanonicalObservationObsolete(store, input, "bind-state-missing", now);
              return "obsolete";
            }
            const bound = recordRoleAgentSession(sessions, {
              agentId: input.fence.agentId,
              adapterId,
              nativeSessionId: decision.outcome.nativeSessionId,
              launchId: input.fence.launchId,
              policy: "fixed",
              status: "running",
              effective: run.effective
            }, now);
            const withProvider = bindOrSupersedeProviderRuntime(bound, input, now);
            store.saveTaskRoleSessionSet(withProvider);
            const driver = this.drivers.require(input.fence.driverId);
            if (driver.capabilities.observation.sessionBootstrap === "discovered"
              && run.pushedAt === undefined) {
              const pushed = markAgentRunPushed(run, now);
              store.saveAgentRun(pushed);
              markTaskRoleRunPushedInFlight(store, role, pushed, now);
              store.saveEvent(taskId, createTaskEvent(
                store.nextEventId(taskId),
                taskId,
                "run.pushed",
                runLaunchEventPayload(pushed),
                now
              ));
            }
            completeRuntimeHookReservation(
              store,
              { scope: "task", taskId, roleName: input.fence.roleName },
              input.fence.launchId
            );
          }
          const current = store.getTaskRoleSessionSet(
            input.fence.taskId!,
            input.fence.roleName
          );
          const currentSession = current?.sessions[input.fence.agentId];
          if (current !== null && current !== undefined
            && current.inFlight !== null
            && currentSession?.nativeSessionId === input.fence.nativeSessionId) {
            store.saveTaskRoleSessionSet(bindOrSupersedeProviderRuntime(current, input, now));
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
      const roleTarget = {
        kind: "role" as const,
        taskId: input.fence.taskId!,
        roleName: input.fence.roleName
      };
      const mailbox = store.getWorkMailbox(roleTarget);
      const processing = mailbox?.processing;
      const inputDelivery = mailbox?.inputDelivery;
      const continuation = inputDelivery !== null
        && inputDelivery !== undefined
        && inputDelivery.attemptId === input.fence.receiptId
        && inputDelivery.executionRef.type === "run"
        && inputDelivery.executionRef.taskId === input.fence.taskId
        && inputDelivery.executionRef.id === input.fence.runId
        && inputDelivery.attemptId !== formatAgentRunReceiptId(
          input.fence.taskId!,
          input.fence.runId!
        );
      const humanAttemptId = input.fence.receiptId;
      if (humanAttemptId !== undefined && humanAttemptId.startsWith("human:")) {
        const active = store.getActiveAgentRun(input.fence.taskId!, input.fence.roleName);
        const sessions = store.getTaskRoleSessionSet(
          input.fence.taskId!,
          input.fence.roleName
        );
        const session = sessions?.sessions[input.fence.agentId];
        const binding = sessions?.providerBinding;
        if (active === null || active.id !== input.fence.runId
          || sessions === null || sessions === undefined
          || binding === null || binding === undefined
          || binding.authority.owner !== "human"
          || !humanAttemptId.startsWith(`human:${binding.authority.holderId}:`)
          || binding.turn?.attemptId !== humanAttemptId
          || session?.launchId !== input.fence.launchId
          || session.nativeSessionId !== input.fence.nativeSessionId) {
          recordCanonicalObservationObsolete(store, input, "human-turn-fence-mismatch", now);
          return "obsolete";
        }
        store.saveTaskRoleSessionSet(recordStructuredProviderAcceptance(
          updateRoleAgentSessionStatus(sessions, input.fence.agentId, "running", now),
          input,
          now
        ));
        store.saveEvent(input.fence.taskId!, createTaskEvent(
          store.nextEventId(input.fence.taskId!),
          input.fence.taskId!,
          "run.human-input-delivered",
          {
            attemptId: humanAttemptId,
            runId: active.id,
            authorityEpoch: String(binding.authority.epoch),
            nativeTurnId: input.fence.nativeTurnId!
          },
          now
        ));
        return "applied";
      }
      if (continuation) {
        const active = store.getActiveAgentRun(input.fence.taskId!, input.fence.roleName);
        const sessions = store.getTaskRoleSessionSet(
          input.fence.taskId!,
          input.fence.roleName
        );
        const session = sessions?.sessions[input.fence.agentId];
        if (active === null
          || active.id !== input.fence.runId
          || active.status !== "active"
          || active.pushedAt === undefined
          || sessions?.inFlight?.runId !== active.id
          || session?.launchId !== input.fence.launchId
          || session.nativeSessionId !== input.fence.nativeSessionId) {
          recordCanonicalObservationObsolete(store, input, "continuation-fence-mismatch", now);
          return "obsolete";
        }
        store.saveTaskRoleSessionSet(recordStructuredProviderAcceptance(
          updateRoleAgentSessionStatus(
            sessions,
            input.fence.agentId,
            "running",
            now
          ),
          input,
          now
        ));
        const role = store.getRole(input.fence.taskId!, input.fence.roleName);
        if (role !== null && role.status !== "running") {
          store.saveRole(input.fence.taskId!, updateRoleStatus(role, "running", now));
        }
        store.saveEvent(input.fence.taskId!, createTaskEvent(
          store.nextEventId(input.fence.taskId!),
          input.fence.taskId!,
          "run.input-delivered",
          {
            attemptId: inputDelivery!.attemptId,
            runId: active.id,
            conversationId: input.fence.conversationId ?? input.fence.nativeSessionId!,
            activationId: input.fence.activationId ?? input.fence.launchId,
            ...(input.fence.nativeTurnId === undefined
              ? {}
              : { nativeTurnId: input.fence.nativeTurnId })
          },
          now
        ));
        store.saveWorkMailbox(completeMailboxInputDelivery(
          mailbox!,
          inputDelivery!.attemptId,
          now
        ));
        if (active.providerRetry !== undefined) {
          this.clearProviderRetryProjection(store, active, input, "provider-accepted", now);
        }
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
      const active = store.getActiveAgentRun(input.fence.taskId!, input.fence.roleName);
      if (active === null
        || active.id !== input.fence.runId
        || active.status !== "active") {
        recordCanonicalObservationObsolete(store, input, "run-not-active", now);
        return "obsolete";
      }
      const role = store.getRole(input.fence.taskId!, input.fence.roleName);
      if (role === null) {
        recordCanonicalObservationObsolete(store, input, "role-missing", now);
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
      const progressed = clearProviderRetryOnProgress(active);
      if (progressed !== active) {
        store.saveAgentRun(progressed);
        store.saveEvent(input.fence.taskId!, createTaskEvent(
          store.nextEventId(input.fence.taskId!),
          input.fence.taskId!,
          "runtime.provider-retry-recovered",
          {
            runId: active.id,
            roleName: active.roleName,
            evidence: "provider-accepted",
            nativeSessionId: input.fence.nativeSessionId ?? "",
            episodeId: active.providerRetry?.episodeId ?? "",
            consecutiveFailures: String(active.providerRetry?.consecutiveFailures ?? 0),
            dispatchedRetries: String(active.providerRetry?.dispatchedRetries ?? 0),
            recoveryLatencyMs: String(active.providerRetry === undefined
              ? 0
              : Math.max(0, now.getTime() - Date.parse(active.providerRetry.firstFailureAt)))
          },
          now
        ));
      }
      if (progressed.deliveredAt === undefined) {
        const delivered = markAgentRunDelivered(progressed, now);
        store.saveAgentRun(delivered);
        markTaskRoleRunDeliveredInFlight(store, role, delivered, now);
        store.saveEvent(input.fence.taskId!, createTaskEvent(
          store.nextEventId(input.fence.taskId!),
          input.fence.taskId!,
          "run.delivered",
          runLaunchEventPayload(delivered),
          now
        ));
      }
      if (processing !== null && processing !== undefined
        && processing.batchId === input.fence.receiptId
        && processing.executionRef?.type === "run"
        && processing.executionRef.taskId === input.fence.taskId
        && processing.executionRef.id === input.fence.runId) {
        store.saveWorkMailbox(completeProcessing(mailbox!, processing.batchId));
      }
      return "applied";
    });
  }

  private clearProviderRetryForProgress(
    input: RuntimeObservation,
    evidence: string,
    now: Date
  ): void {
    this.store.transaction((store) => {
      const taskId = input.fence.taskId;
      const runId = input.fence.runId;
      if (taskId === undefined || runId === undefined) return;
      const run = store.getAgentRun(taskId, runId);
      if (run === null || run.status !== "active" || run.providerRetry === undefined) return;
      this.clearProviderRetryProjection(store, run, input, evidence, now);
    });
  }

  private clearProviderRetryProjection(
    store: TaskStore,
    run: AgentRun,
    input: RuntimeObservation,
    evidence: string,
    now: Date
  ): void {
    const retry = run.providerRetry;
    if (retry === undefined) return;
    store.saveAgentRun(clearProviderRetryOnProgress(run));
    store.saveEvent(run.taskId, createTaskEvent(
      store.nextEventId(run.taskId),
      run.taskId,
      "runtime.provider-retry-recovered",
      {
        runId: run.id,
        roleName: input.fence.roleName,
        evidence,
        episodeId: retry.episodeId,
        consecutiveFailures: String(retry.consecutiveFailures),
        dispatchedRetries: String(retry.dispatchedRetries),
        recoveryLatencyMs: String(Math.max(
          0,
          now.getTime() - Date.parse(retry.firstFailureAt)
        )),
        nativeSessionId: input.fence.nativeSessionId ?? "",
        activityId: input.payload.activityId ?? ""
      },
      now
    ));
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
    const expectation = this.projectRunExpectation(
      store,
      event.fence,
      observation.fence.runId
    );
    if (expectation === null) {
      return preallocatedRuntimeReadyAwaitingProjection(
        store,
        observation,
        this.drivers
      )
        ? { kind: "apply", outcome: { outcome: "mark-ready", preInputReady: true } }
        : { kind: "obsolete", reason: "run-or-role-missing" };
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

  /** Reads durable Run + session state into the pure fold's expectation shape. */
  private projectRunExpectation(
    store: TaskStore,
    fence: CanonicalIdentityFence,
    runId: string | undefined
  ): CanonicalRunExpectation | null {
    const role = store.getRole(fence.taskId, fence.roleName);
    if (role === null) return null;
    const sessionSet = store.getTaskRoleSessionSet(fence.taskId, fence.roleName);
    const session = sessionSet?.sessions[fence.agentId] ?? null;
    const boundNativeSessionId = session?.nativeSessionId;
    if (runId === undefined) {
      return {
        fence,
        sessionStarted: false,
        ready: false,
        pushed: false,
        accepted: false,
        terminal: false,
        ...(boundNativeSessionId === undefined ? {} : { boundNativeSessionId })
      };
    }
    const run = store.getAgentRun(fence.taskId, runId);
    const inFlight = sessionSet?.inFlight;
    if (run === null
      || inFlight === null
      || inFlight === undefined
      || inFlight.runId !== run.id
      || inFlight.agentId !== run.effective.agentId) return null;
    const owner = { scope: "task" as const, taskId: fence.taskId, roleName: fence.roleName };
    const launchId = session?.launchId
      ?? (runtimeHookMatchesReservation(store, owner, fence.launchId) ? fence.launchId : undefined);
    if (launchId === undefined) return null;
    const expectedFence: CanonicalIdentityFence = {
      taskId: fence.taskId,
      roleName: fence.roleName,
      agentId: run.effective.agentId,
      adapterId: run.effective.adapterId,
      runId: run.id,
      launchId,
      receiptId: inFlight.receiptId,
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
        && observation.fence.launchId === launchId
        && observation.fence.nativeSessionId === (boundNativeSessionId ?? fence.nativeSessionId)
        ? [observation]
        : [];
    });
    return {
      fence: expectedFence,
      sessionStarted: lifecycleEvents.length > 0,
      ready: lifecycleEvents.some((event) => event.kind === "session.ready"),
      pushed: run.pushedAt !== undefined,
      accepted: run.deliveredAt !== undefined,
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
    runId?: string;
    launchId?: string;
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
    launchId?: string;
    nativeSessionId: string;
  }>, now = new Date()): RoleAgentSession {
    return this.store.transaction((store) => (
      recordGlobalRuntimeNativeSession(store, input, now)
    ));
  }

  observeGlobalRuntimeTurnCompleted(input: Readonly<{
    roleName: string;
    agentId: string;
    adapterId: string;
    launchId?: string;
    nativeSessionId: string;
    turnId: string;
    title?: string;
    summary?: string;
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
        && !runtimeHookMatchesReservation(store, owner, input.launchId)
      ) {
        throw new Error(
          "Runtime turn completion does not match the global launch reservation."
        );
      }
      const effectiveExisting = nativeTransitionExisting(
        store,
        owner,
        existing,
        input.nativeSessionId,
        input.launchId,
        "Runtime turn completion conflicts with the fixed global Role session."
      );
      const effective = globalSessionEffective(role, effectiveExisting);
      if (effective.agentId !== input.agentId || effective.adapterId !== input.adapterId) {
        throw new Error("Runtime turn completion does not match the effective global launch identity.");
      }
      const completedStatus = effectiveExisting?.status === "stopped"
        || effectiveExisting?.status === "broken"
        ? effectiveExisting.status
        : "ready";
      current = recordRoleAgentSession(current, {
        agentId: input.agentId,
        adapterId: input.adapterId,
        nativeSessionId: input.nativeSessionId,
        ...(input.launchId === undefined ? {} : { launchId: input.launchId }),
        title: effectiveExisting?.title ?? input.title,
        preview: effectiveExisting?.preview ?? (
          input.summary === undefined ? undefined : sessionPreview(input.summary)
        ),
        policy: "fixed",
        status: completedStatus,
        effective
      }, now);
      current = rememberRoleAgentCompletedTurn(
        current,
        input.agentId,
        input.nativeSessionId,
        input.turnId,
        now
      );
      store.saveGlobalRoleSessionSet(current);
      completeRuntimeHookReservation(store, owner, input.launchId);
      return current.sessions[input.agentId]!;
    });
  }

  classifyGlobalRuntimeTurnCompleted(input: Readonly<{
    roleName: string;
    agentId: string;
    adapterId: string;
    launchId?: string;
    nativeSessionId: string;
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
      && !runtimeHookMatchesReservation(this.store, owner, input.launchId)
    ) return "obsolete";
    let effectiveExisting: RoleAgentSession | undefined;
    try {
      effectiveExisting = nativeTransitionExisting(
        this.store,
        owner,
        existing,
        input.nativeSessionId,
        input.launchId,
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

function hasUnsettledRuntimeOperations(
  store: TaskStore,
  taskId: string,
  runId: string
): boolean {
  return store.listEvents(taskId).some((event) => {
    const observation = runtimeObservationFromTaskEvent(event);
    return observation !== null
      && observation.fence.runId === runId
      && observation.kind === "operation.started";
  });
}

function runtimeTurnFailureSummary(input: TaskRuntimeTurnFailed): string {
  return [
    "Agent runtime turn failed.",
    `error: ${input.error}`,
    ...(input.errorDetails === undefined
      ? []
      : [`error_details: ${input.errorDetails}`]),
    ...(input.lastAssistantMessage === undefined
      ? []
      : [`last_assistant_message: ${input.lastAssistantMessage}`])
  ].join("\n");
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
    launchId: input.fence.launchId,
    ...(input.fence.runId === undefined ? {} : { runId: input.fence.runId }),
    ...(input.fence.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: input.fence.nativeSessionId }),
    ...(input.fence.receiptId === undefined ? {} : { receiptId: input.fence.receiptId })
  };
}

/** Accepts the original Run receipt or a later mailbox activation receipt. */
function runtimeReceiptBelongsToRun(
  store: TaskStore,
  input: RuntimeObservation
): boolean {
  const taskId = input.fence.taskId!;
  const runId = input.fence.runId!;
  const receiptId = input.fence.receiptId;
  if (receiptId === formatAgentRunReceiptId(taskId, runId)) return true;
  if (receiptId === undefined) return false;
  return store.listEvents(taskId).some((event) => {
    const accepted = runtimeObservationFromTaskEvent(event);
    return accepted?.kind === "turn.accepted"
      && accepted.fence.runId === runId
      && accepted.fence.roleName === input.fence.roleName
      && accepted.fence.agentId === input.fence.agentId
      && accepted.fence.launchId === input.fence.launchId
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
    ...(input.fence.runId === undefined ? {} : { runId: input.fence.runId }),
    launchId: input.fence.launchId,
    nativeSessionId: input.fence.nativeSessionId ?? input.fence.sessionGenerationId
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
    runId?: string;
    launchId?: string;
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
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.launchId === undefined ? {} : { launchId: input.launchId }),
      reason
    },
    now
  ));
}

function isLeaderDisposedWorkItemRun(
  store: TaskStore,
  input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    runId?: string;
  }>
): boolean {
  if (input.runId === undefined) return false;
  const run = store.getAgentRun(input.taskId, input.runId);
  if (run === null
    || run.status !== "failed"
    || run.roleName !== input.roleName
    || run.effective.agentId !== input.agentId
    || run.workItemId === undefined) {
    return false;
  }
  return store.getWorkItem(input.taskId, run.workItemId)?.disposition !== undefined;
}

function isObsoleteTerminalRuntimeRun(
  store: TaskStore,
  input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    runId?: string;
  }>
): boolean {
  if (isLeaderDisposedWorkItemRun(store, input)) return true;
  if (input.runId === undefined) return false;
  const run = store.getAgentRun(input.taskId, input.runId);
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
    && event.payload.runId === input.runId
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
  launchId: string
) {
  const mailbox = store.getWorkMailbox(runtimeLifecycleTarget(owner));
  if (!isRuntimeLaunchReservation(mailbox?.processing, launchId)) {
    throw new Error("Runtime launch reservation no longer matches the launch.");
  }
  return mailbox!;
}

function runtimeHookMatchesReservation(
  store: TaskStore,
  owner: RuntimeRoleOwner,
  launchId: string | undefined
): boolean {
  const mailbox = store.getWorkMailbox(runtimeLifecycleTarget(owner));
  if (hasRuntimeCleanupObligation(mailbox)) return false;
  const processing = mailbox?.processing;
  return launchId !== undefined
    && isRuntimeLaunchReservation(processing, launchId);
}

function preallocatedRuntimeReadyAwaitingProjection(
  store: TaskStore,
  observation: RuntimeObservation,
  drivers: AgentDriverRegistry
): boolean {
  const taskId = observation.fence.taskId;
  const runId = observation.fence.runId;
  const nativeSessionId = observation.fence.nativeSessionId;
  const driver = drivers.find(observation.fence.driverId);
  if (observation.kind !== "session.ready"
    || driver?.capabilities.observation.sessionBootstrap !== "preallocated"
    || taskId === undefined
    || runId === undefined
    || nativeSessionId === undefined) return false;

  const task = store.getTask(taskId);
  const role = store.getRole(taskId, observation.fence.roleName);
  const run = store.getActiveAgentRun(taskId, observation.fence.roleName);
  const sessions = store.getTaskRoleSessionSet(taskId, observation.fence.roleName);
  if (task?.status !== "active"
    || role?.activeAgentId !== observation.fence.agentId
    || run?.id !== runId
    || run.status !== "active"
    || run.effective.agentId !== observation.fence.agentId
    || run.effective.adapterId !== driver.adapterId
    || observation.fence.receiptId !== agentRunDeliveryReceiptId(run)
    || (sessions?.inFlight !== null && sessions?.inFlight !== undefined)
    || sessions?.sessions[observation.fence.agentId] !== undefined) return false;

  const mailbox = store.getWorkMailbox(runtimeLifecycleTarget({
    scope: "task",
    taskId,
    roleName: observation.fence.roleName
  }));
  const executionRef = mailbox?.processing?.executionRef;
  return isRuntimeLaunchReservation(mailbox?.processing, observation.fence.launchId)
    && !hasRuntimeCleanupObligation(mailbox)
    && executionRef?.type === "run"
    && executionRef.taskId === taskId
    && executionRef.id === runId
    && nativeSessionId === nativeSessionIdForLaunch(
      store.rootDirectory(),
      observation.fence.launchId,
      observation.fence.agentId,
      driver.adapterId
    );
}

function completeRuntimeHookReservation(
  store: TaskStore,
  owner: RuntimeRoleOwner,
  launchId: string | undefined
): void {
  if (launchId === undefined) return;
  const mailbox = store.getWorkMailbox(runtimeLifecycleTarget(owner));
  if (!isRuntimeLaunchReservation(mailbox?.processing, launchId)) return;
  saveRuntimeLifecycleMailbox(
    store,
    completeProcessing(mailbox!, launchId)
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
    && store.getActiveAgentRun(owner.taskId, owner.roleName) !== null
  ) {
    return false;
  }
  const sessions = runtimeOwnerSessionSet(store, owner);
  const active = sessions?.sessions[sessions.activeAgentId];
  return active !== undefined
    && active.status !== "stopped"
    && active.agentId === candidate.agentId
    && active.adapterId === candidate.adapterId
    && active.nativeSessionId === candidate.nativeSessionId
    && active.launchId === candidate.launchId
    && active.updatedAt === candidate.sessionUpdatedAt;
}

function markRuntimeOwnerSessionStopped(
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
    if (active === undefined || active.status === "stopped") return false;
    store.saveTaskRoleSessionSet(updateRoleAgentSessionStatus(
      sessions,
      sessions.activeAgentId,
      "stopped",
      now
    ));
    return true;
  }
  const sessions = store.getGlobalRoleSessionSet(owner.roleName);
  if (sessions === null) return false;
  const active = sessions.sessions[sessions.activeAgentId];
  if (active === undefined || active.status === "stopped") return false;
  store.saveGlobalRoleSessionSet(updateRoleAgentSessionStatus(
    sessions,
    sessions.activeAgentId,
    "stopped",
    now
  ));
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

function preparedSessionMatches(
  session: RoleAgentSession | undefined,
  agentId: string,
  adapterId: string,
  nativeSessionId: string | undefined,
  launchId: string | undefined
): boolean {
  if (session === undefined) return nativeSessionId === undefined;
  if (
    session.agentId !== agentId
    || session.adapterId !== adapterId
    || session.status === "stopped"
    || session.status === "broken"
    || (nativeSessionId !== undefined
      && session.nativeSessionId !== nativeSessionId)
  ) {
    return false;
  }
  return launchId === undefined
    ? session.launchId === undefined
    : session.launchId === launchId;
}

function finalizeProviderRetryDeadline(
  store: TaskStore,
  run: AgentRun,
  summary: string,
  reason: string,
  now: Date
): boolean {
  const retry = run.providerRetry;
  if (retry === undefined) return false;
  const terminalization = terminalizeExactTaskRun(store, {
    taskId: run.taskId,
    roleName: run.roleName,
    agentId: run.effective.agentId,
    runId: run.id,
    receiptId: agentRunDeliveryReceiptId(run),
    outcome: { status: "failed", summary }
  }, now);
  if (terminalization.disposition !== "applied" || terminalization.run === null) return false;
  const terminal = terminalization.run;
  store.saveEvent(run.taskId, createTaskEvent(
    store.nextEventId(run.taskId),
    run.taskId,
    "runtime.provider-retry-exhausted",
    {
      runId: run.id,
      roleName: run.roleName,
      episodeId: retry.episodeId,
      reason,
      consecutiveFailures: String(retry.consecutiveFailures),
      dispatchedRetries: String(retry.dispatchedRetries),
      elapsedMs: String(Math.max(0, now.getTime() - Date.parse(retry.firstFailureAt)))
    },
    now
  ));
  if (terminal.purpose === "execution" && terminal.workItemId !== undefined) {
    const item = store.getWorkItem(run.taskId, terminal.workItemId);
    if (item !== null
      && !["completed", "failed", "retired"].includes(item.status)
      && !workItemOwnsUnresolvedExecutionLane(
        item,
        terminal.executionGroupId,
        terminal.executionLaneId
      )) {
      store.saveWorkItem(run.taskId, updateWorkItemStatus(item, "failed", now, summary));
    }
  }
  const role = store.getRole(run.taskId, run.roleName);
  if (role !== null) {
    store.saveRole(
      run.taskId,
      updateRoleStatus(role, run.roleName === "leader" ? "failed" : "idle", now)
    );
  }
  if (run.roleName === "leader") {
    store.saveLeaderFailure(recordLeaderFailure(
      run.taskId,
      retry.nativeSessionId ?? "(unproven)",
      summary,
      now,
      store.getLeaderFailure(run.taskId)
    ));
    store.saveOperatorNotification(createLeaderRecoveryNotification(
      run.taskId,
      summary,
      now,
      store.getOperatorNotification(run.taskId)
    ));
    enqueueWork(store, { kind: "operator" }, "provider-retry-exhausted", now, [
      { type: "task", id: run.taskId },
      { type: "run", taskId: run.taskId, id: run.id }
    ]);
  } else {
    enqueueWork(
      store,
      { kind: "role", taskId: run.taskId, roleName: "leader" },
      "provider-retry-exhausted",
      now,
      [{ type: "run", taskId: run.taskId, id: run.id }]
    );
  }
  return true;
}

function preparedDeliveryFailureSessionFenceMatches(
  sessions: TaskRoleSessionSet | null,
  session: RoleAgentSession | undefined,
  input: Pick<
    RoleRunDeliveryFailurePersistence,
    "taskId" | "agentId" | "adapterId" | "runId" | "nativeSessionId" | "launchId"
  >,
  expectedReceiptId: string
): boolean {
  if (sessions === null) return input.nativeSessionId === undefined;
  if (sessions.activeAgentId !== input.agentId) return false;
  if (sessions.inFlight === null) {
    return input.nativeSessionId === undefined
      && session === undefined;
  }
  return sessions.inFlight.agentId === input.agentId
    && sessions.inFlight.runId === input.runId
    && sessions.inFlight.receiptId === expectedReceiptId
    && sessions.inFlight.pushedAt === undefined
    && preparedSessionMatches(
      session,
      input.agentId,
      input.adapterId,
      input.nativeSessionId,
      input.launchId
    );
}

function preparedReservationMatches(
  mailbox: WorkMailbox | null,
  taskId: string,
  runId: string,
  launchId: string | undefined
): boolean {
  if (launchId === undefined) {
    return !isRuntimeLaunchReservation(mailbox?.processing);
  }
  const processing = mailbox?.processing;
  return isRuntimeLaunchReservation(processing, launchId)
    && !hasRuntimeCleanupObligation(mailbox)
    && processing?.executionRef?.type === "run"
    && processing.executionRef.taskId === taskId
    && processing.executionRef.id === runId;
}

function matchingPreparedRuntimeReservation(
  store: TaskStore,
  input: Readonly<{
    task: { id: string };
    role: { name: string };
    run: { id: string };
    session: SchedulerRoleSession | null;
    launchId?: string;
  }>
): WorkMailbox | null {
  if (
    input.launchId === undefined
    || input.session?.nativeSessionId === undefined
  ) {
    return null;
  }
  const owner = {
    scope: "task" as const,
    taskId: input.task.id,
    roleName: input.role.name
  };
  const mailbox = store.getWorkMailbox(runtimeLifecycleTarget(owner));
  if (
    isRuntimeLaunchReservation(mailbox?.processing, input.launchId)
    && mailbox?.processing?.executionRef?.type === "run"
    && mailbox.processing.executionRef.id === input.run.id
    && !hasRuntimeCleanupObligation(mailbox)
  ) {
    return mailbox;
  }
  throw new Error("Prepared Role session does not match its launch generation.");
}

function completePreparedRuntimeReservation(
  store: TaskStore,
  mailbox: WorkMailbox | null
): void {
  if (mailbox === null || mailbox.processing === null) return;
  saveRuntimeLifecycleMailbox(
    store,
    completeProcessing(mailbox, mailbox.processing.batchId)
  );
}

function recordTaskRuntimeNativeSession(
  store: TaskStore,
  input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    launchId?: string;
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
  if (task.status !== "active") {
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
    input.launchId,
    "Native session registration conflicts with the fixed Role session."
  );
  if (existing?.status === "running"
    && (input.launchId === undefined || existing.launchId === input.launchId)) return existing;
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
  if (!effectiveLaunchSnapshotsCompatibleForTaskMain(
    resolvedEffective,
    effective,
    store.getTaskWorkspace(input.taskId)
  )) {
    throw new Error("Reserved native Session effective launch changed before persistence.");
  }
  if (effective.agentId !== input.agentId || effective.adapterId !== input.adapterId) {
    throw new Error("Native session registration does not match the effective launch identity.");
  }
  const updated = recordRoleAgentSession(current, {
    agentId: input.agentId,
    adapterId: input.adapterId,
    nativeSessionId: input.nativeSessionId,
    ...(input.launchId === undefined ? {} : { launchId: input.launchId }),
    policy: "fixed",
    status: "running",
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
    launchId?: string;
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
    input.launchId,
    "Native session registration conflicts with the fixed global Role session."
  );
  if (existing?.status === "running"
    && (input.launchId === undefined || existing.launchId === input.launchId)) return existing;
  const resolvedEffective = globalSessionEffective(role, effectiveExisting);
  const effective = input.effective === undefined
    ? resolvedEffective
    : validateEffectiveLaunchSnapshot(input.effective);
  if (!effectiveLaunchSnapshotsCompatible(resolvedEffective, effective)) {
    throw new Error("Reserved global native Session effective launch changed before persistence.");
  }
  if (effective.agentId !== input.agentId || effective.adapterId !== input.adapterId) {
    throw new Error("Native session registration does not match the effective global launch identity.");
  }
  const updated = recordRoleAgentSession(current, {
    agentId: input.agentId,
    adapterId: input.adapterId,
    nativeSessionId: input.nativeSessionId,
    ...(input.launchId === undefined ? {} : { launchId: input.launchId }),
    policy: "fixed",
    status: "running",
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
  launchId: string | undefined,
  conflictMessage: string
): RoleAgentSession | undefined {
  if (existing === undefined || existing.nativeSessionId === nativeSessionId) {
    return existing;
  }
  if (
    (existing.status === "stopped" || existing.status === "broken")
    && runtimeHookMatchesReservation(store, owner, launchId)
  ) {
    return undefined;
  }
  throw new Error(conflictMessage);
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
    ...(workspace === undefined ? {} : { managedWorkspace: workspace }),
    status: role.status
  };
}

function taskSessionEffective(
  store: TaskStore,
  taskId: string,
  roleName: string,
  agentId: string,
  existing: RoleAgentSession | undefined
) {
  const active = store.getActiveAgentRun(taskId, roleName);
  if (active !== null) {
    if (active.effective.agentId !== agentId) {
      throw new Error(
        `Native Session registration does not match the effective Run Agent: ${taskId}/${roleName}.`
      );
    }
    if (existing !== undefined) {
      const workspace = active.workspace ?? store.getTaskWorkspace(taskId);
      if (!effectiveLaunchSnapshotsCompatibleForTaskMain(
        existing.effective,
        active.effective,
        workspace
      )) {
        throw new Error(
          `Native Session effective launch does not match the active Run: ${taskId}/${roleName}.`
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
    ...(session.launchId === undefined ? {} : { launchId: session.launchId }),
    ...(session.title === undefined ? {} : { title: session.title }),
    status: session.status,
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
  launchId?: string
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
    ...(launchId === undefined ? {} : { launchId }),
    ...(session.title === undefined ? {} : { title: session.title }),
    policy: "fixed",
    status,
    effective: session.effective
  }, now);
  store.saveRoleSessionSet(updated);
}

function bindTaskRoleRunInFlight(
  store: TaskStore,
  role: NonNullable<ReturnType<TaskStore["getRole"]>>,
  run: AgentRun,
  now: Date
): void {
  const agentId = run.effective.agentId;
  let current = store.getRoleSessionSet(role.taskId, role.name)
    ?? createRoleSessionSet(
      { scope: "task", taskId: role.taskId, roleName: role.name },
      agentId,
      now
    );
  if (current.activeAgentId !== agentId) {
    if (current.inFlight !== null || current.providerBinding !== null) {
      throw new Error("Task Role Session identity cannot change with an unsettled Run fence.");
    }
    const liveConflict = Object.values(current.sessions).find((session) => (
      session.agentId !== agentId
      && session.status !== "stopped"
      && session.status !== "broken"
    ));
    if (liveConflict !== undefined) {
      throw new Error(
        `Task Role Session identity cannot change while ${liveConflict.agentId} is live.`
      );
    }
    current = {
      ...current,
      activeAgentId: agentId,
      updatedAt: now.toISOString()
    };
  }
  const updated = bindTaskRoleRun(current, {
    agentId,
    runId: run.id,
    receiptId: agentRunDeliveryReceiptId(run)
  }, now, run.mode);
  store.saveRoleSessionSet(updated);
}

function markTaskRoleRunPushedInFlight(
  store: TaskStore,
  role: NonNullable<ReturnType<TaskStore["getRole"]>>,
  run: AgentRun,
  now: Date
): void {
  const current = store.getRoleSessionSet(role.taskId, role.name);
  if (current === null) {
    throw new Error(`Task Role session set is missing for pushed Run: ${run.id}.`);
  }
  const updated = markTaskRoleRunPushed(current, {
    agentId: run.effective.agentId,
    runId: run.id,
    receiptId: agentRunDeliveryReceiptId(run)
  }, now);
  store.saveRoleSessionSet(updated);
}

function markTaskRoleRunDeliveredInFlight(
  store: TaskStore,
  role: NonNullable<ReturnType<TaskStore["getRole"]>>,
  run: AgentRun,
  now: Date
): void {
  const current = store.getRoleSessionSet(role.taskId, role.name);
  if (current === null) {
    throw new Error(`Task Role session set is missing for delivered Run: ${run.id}.`);
  }
  const updated = markTaskRoleRunDelivered(current, {
    agentId: run.effective.agentId,
    runId: run.id,
    receiptId: agentRunDeliveryReceiptId(run)
  }, now);
  store.saveRoleSessionSet(updated);
}

function clearTaskRoleRunInFlight(
  store: TaskStore,
  role: NonNullable<ReturnType<TaskStore["getRole"]>>,
  run: AgentRun,
  now: Date
): void {
  const current = store.getRoleSessionSet(role.taskId, role.name);
  if (current === null) return;
  if (current.inFlight?.runId !== run.id) return;
  const updated = clearTaskRoleRun(current, {
    agentId: run.effective.agentId,
    runId: run.id,
    receiptId: agentRunDeliveryReceiptId(run)
  }, now);
  store.saveRoleSessionSet(updated);
}

function breakTaskSessionIfPresent(
  store: TaskStore,
  taskId: string,
  roleName: string,
  agentId: string,
  now: Date
): void {
  updateTaskSessionStatusIfPresent(store, taskId, roleName, agentId, "broken", now);
}

function stopTaskSessionIfPresent(
  store: TaskStore,
  taskId: string,
  roleName: string,
  agentId: string,
  now: Date
): void {
  updateTaskSessionStatusIfPresent(store, taskId, roleName, agentId, "stopped", now);
}

function updateTaskSessionStatusIfPresent(
  store: TaskStore,
  taskId: string,
  roleName: string,
  agentId: string,
  status: AgentSessionStatus,
  now: Date
): void {
  const set = store.getRoleSessionSet(taskId, roleName);
  if (set === null || set.sessions[agentId] === undefined) return;
  store.saveRoleSessionSet(updateRoleAgentSessionStatus(set, agentId, status, now));
}

function schedulerRoleSessionsMatch(
  current: SchedulerRoleSession | null,
  expected: SchedulerRoleSession | null
): boolean {
  if (current === null || expected === null) return current === expected;
  return current.agentId === expected.agentId
    && current.adapterId === expected.adapterId
    && current.nativeSessionId === expected.nativeSessionId
    && current.launchId === expected.launchId
    && isDeepStrictEqual(current.effective, expected.effective);
}

function matchesStallSessionFence(
  current: SchedulerRoleSession | null,
  expected: RoleRunStallPersistence["session"]
): boolean {
  if (current === null || expected === null) return current === expected;
  return current.agentId === expected.agentId
    && current.adapterId === expected.adapterId
    && current.nativeSessionId === expected.nativeSessionId
    && current.launchId === expected.launchId
    && current.status === expected.status;
}

function requireRole(store: TaskStore, taskId: string, roleName: string) {
  const role = store.getRole(taskId, roleName);
  if (role === null) throw new Error(`Role not found: ${taskId}/${roleName}.`);
  return role;
}

function runLaunchEventPayload(run: AgentRun): Record<string, string> {
  return {
    runId: run.id,
    role: run.roleName,
    purpose: run.purpose,
    mode: run.mode,
    agent: `${run.effective.agentId}/${run.effective.adapterId}`,
    effectiveRevision: String(run.effective.sourceDesiredRevision),
    profileAccess: run.effective.profileAccess,
    effectivePermission: run.effective.permission.strategy,
    writeProjectIds: run.effective.writeProjectIds.join(",") || "none"
  };
}

function runtimeObservationTelemetryEntry(
  input: RuntimeObservation
): TelemetryProgressEntry {
  return {
    taskId: input.fence.taskId!,
    roleName: input.fence.roleName,
    runId: input.fence.runId!,
    generation: input.fence.sessionGenerationId,
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
      launchId: input.fence.launchId,
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
 * Runtime observations are a current-state snapshot, not an append-only
 * semantic history. Retain active operations, one latest usage baseline, and
 * one latest confirmed activity boundary so a token stream remains
 * O(active operations) per Run without losing the delta that was already
 * proven before an unchanged later snapshot arrived.
 */
function compactedRuntimeObservationIds(
  events: readonly TaskEvent[],
  incoming: RuntimeObservation
): string[] {
  const existing = events.flatMap((event) => {
    const observation = runtimeObservationFromTaskEvent(event);
    const matches = incoming.kind.startsWith("operation.")
      ? observation !== null
        && runtimeObservationRunFenceMatches(observation.fence, incoming.fence)
      : observation !== null
        && runtimeObservationFenceMatches(observation.fence, incoming.fence);
    return observation !== null
      && matches
      ? [{ event, observation }]
      : [];
  });
  const remove = ({ observation }: typeof existing[number]): boolean => {
    if (incoming.kind === "activity.observed") {
      return observation.kind === "activity.observed"
        && (observation.payload.usage === undefined)
          === (incoming.payload.usage === undefined);
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
  if (current.turn?.attemptId === attemptId
    && current.turn.turnId === turnId
    && ["accepted", "running", "completed", "failed", "cancelled"].includes(
      current.turn.status
    )) return sessions;
  const binding = acceptProviderTurn(current, {
    attemptId,
    turnId,
    acceptedAt: input.observedAt ?? input.receivedAt
  });
  return updateTaskRoleProviderRuntime(sessions, binding, now);
}

function bindOrSupersedeProviderRuntime(
  sessions: TaskRoleSessionSet,
  input: RuntimeObservation,
  now: Date
): TaskRoleSessionSet {
  if (sessions.inFlight === null) return sessions;
  const conversationId = input.fence.conversationId ?? input.fence.nativeSessionId!;
  const activationId = input.fence.activationId ?? input.fence.launchId;
  if (sessions.providerBinding === null) {
    return bindTaskRoleProviderRuntime(sessions, createProviderRuntimeBinding({
      providerNamespace: input.fence.driverId,
      accountScope: input.fence.agentId,
      runId: sessions.inFlight.runId,
      conversationId,
      activationId,
      startedAt: sessions.inFlight.preparedAt
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
  const turn = sessions.providerBinding.turn;
  const noUnsettledInputDelivery = turn === null
    || ["completed", "failed", "cancelled", "rejected"].includes(turn.status);
  return updateTaskRoleProviderRuntime(
    sessions,
    supersedeProviderConversation(sessions.providerBinding, {
      conversationId,
      activationId,
      switchedAt: input.observedAt ?? input.receivedAt,
      noUnsettledInputDelivery
    }),
    now
  );
}

function rejectSubmittingProviderTurn(
  store: TaskStore,
  target: MailboxTarget,
  delivery: InputDelivery,
  now: Date,
  reason: string
): void {
  if (target.kind !== "role"
    || delivery.executionRef.type !== "run"
    || delivery.executionRef.taskId !== target.taskId) return;
  const sessions = store.getTaskRoleSessionSet(target.taskId, target.roleName);
  const binding = sessions?.providerBinding;
  if (sessions === null || sessions === undefined
    || binding === null || binding === undefined
    || binding.runId !== delivery.executionRef.id
    || binding.turn?.attemptId !== delivery.attemptId
    || (binding.turn.status !== "submitting"
      && binding.turn.status !== "delivery-unknown")) return;
  store.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(
    sessions,
    rejectProviderTurn(binding, {
      attemptId: delivery.attemptId,
      rejectedAt: now.toISOString(),
      reason
    }),
    now
  ));
}

function deferUnprovenProviderRecovery(
  store: TaskStore,
  run: AgentRun,
  roleName: string,
  reason: string,
  now: Date
): void {
  if (run.providerRetry === undefined) return;
  const deferred = deferProviderRetry(run.providerRetry, now);
  if (deferred === null) {
    finalizeProviderRetryDeadline(
      store,
      run,
      reason,
      "native-resume-unproven",
      now
    );
    return;
  }
  store.saveAgentRun(withProviderRetry(run, deferred));
  store.saveEvent(run.taskId, createTaskEvent(
    store.nextEventId(run.taskId),
    run.taskId,
    "runtime.provider-recovery-attention",
    {
      runId: run.id,
      roleName,
      reason,
      nextAttemptAt: deferred.nextAttemptAt ?? ""
    },
    now
  ));
  enqueueWork(
    store,
    { kind: "operator" },
    "provider-recovery-attention",
    now,
    [
      { type: "task", id: run.taskId },
      { type: "run", taskId: run.taskId, id: run.id }
    ]
  );
}

function markSubmittingProviderTurnUnknown(
  store: TaskStore,
  target: MailboxTarget,
  delivery: InputDelivery,
  now: Date,
  reason: string
): void {
  if (target.kind !== "role"
    || delivery.executionRef.type !== "run"
    || delivery.executionRef.taskId !== target.taskId) return;
  const sessions = store.getTaskRoleSessionSet(target.taskId, target.roleName);
  const binding = sessions?.providerBinding;
  if (sessions === null || sessions === undefined
    || binding === null || binding === undefined
    || binding.runId !== delivery.executionRef.id
    || binding.turn?.attemptId !== delivery.attemptId
    || binding.turn.status !== "submitting") return;
  store.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(
    sessions,
    markProviderTurnDeliveryUnknown(binding, {
      attemptId: delivery.attemptId,
      observedAt: now.toISOString(),
      reason
    }),
    now
  ));
}

function settleStructuredProviderTurn(
  sessions: TaskRoleSessionSet,
  turnId: string,
  status: "completed" | "failed" | "cancelled",
  now: Date
): TaskRoleSessionSet {
  const binding = sessions.providerBinding;
  if (binding === null || binding.turn === null || binding.turn.turnId !== turnId) {
    return sessions;
  }
  if (["completed", "failed", "cancelled"].includes(binding.turn.status)) return sessions;
  return updateTaskRoleProviderRuntime(sessions, settleProviderTurn(binding, {
    turnId,
    status,
    settledAt: now.toISOString()
  }), now);
}

function confirmedUsageActivityObservation(
  events: readonly TaskEvent[],
  incoming: RuntimeObservation
): RuntimeObservation | null {
  const usage = incoming.payload.usage;
  if (incoming.kind !== "activity.observed" || usage === undefined) return null;
  const previous = events
    .map(runtimeObservationFromTaskEvent)
    .filter((observation): observation is RuntimeObservation => (
      observation !== null
      && observation.kind === "activity.observed"
      && observation.payload.usage !== undefined
      && runtimeObservationFenceMatches(observation.fence, incoming.fence)
    ))
    .sort(compareCanonicalObservationOrder)
    .at(-1)?.payload.usage;
  if (previous === undefined
    || usage.inputTokens + usage.outputTokens
      <= previous.inputTokens + previous.outputTokens) return null;
  const digest = createHash("sha256")
    .update(`confirmed-runtime-activity\0${incoming.eventId}`)
    .digest("hex");
  return createRuntimeObservation({
    schemaVersion: 2,
    eventId: `runtime-activity-${digest}`,
    semanticKey: `runtime-activity-${digest}`,
    kind: "activity.observed",
    authority: "controller",
    receivedAt: incoming.receivedAt,
    ...(incoming.observedAt === undefined ? {} : { observedAt: incoming.observedAt }),
    ...(incoming.sequence === undefined ? {} : { sequence: incoming.sequence }),
    ...(incoming.ordinal === undefined ? {} : { ordinal: incoming.ordinal }),
    fence: incoming.fence,
    payload: { activity: incoming.payload.activity ?? "model" }
  });
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

function configuredProviderRetryPolicy(store: TaskStore): Readonly<{
  delaysMs: readonly number[];
  maxWindowMs: number;
}> {
  const config = providerRetryConfig(store.getConfig());
  return { delaysMs: config.delaysMs, maxWindowMs: config.maxWindowMs };
}
