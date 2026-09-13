import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { contextSnapshotRef } from "../context/contextSnapshot.js";
import { freezeRunContextSnapshot } from "../context/runContextPack.js";
import { settleGlobalRetryInput } from "../message/globalProviderRetry.js";
import { interruptThenTerminalState, prepareMessageContinuations } from "../message/messageContinuation.js";
import { assertExecutionEnvironmentCurrent } from "../runtime/executionEnvironment.js";
import { deferProviderRetry, providerRetryPending, recordProviderFailure } from "../runtime/providerRetry.js";
import {
  AgentHostObservationDeferred,
  recordAgentHostConnection,
  resolveAgentHostObservation
} from "./agentHostObservation.js";
import { admitOwnedProviderInput, ownedProviderInput } from "./providerRetryAdmission.js";
import type { RuntimeObservationInboxEvent } from "./runtimeEventInbox.js";
import { RuntimeHookRunFenceError } from "./runtimeHookRunFence.js";

import type { MailboxEntityRef } from "../coordination/workMailbox.js";
import type { DurableJob } from "../job/durableJob.js";
import {
  type SchedulerTelemetry,
  type TelemetryProgressEntry
} from "../telemetry/telemetryStore.js";

import {
  appendRunInput,
  createRun,
  runPurposeAdmitsTaskState,
  withRunContextSnapshot,
  type AgentRun
} from "../agentRun/agentRun.js";
import { createRunInput } from "../context/runInputContract.js";
import {
  buildTaskWakeEnvelope,
  type WakeEnvelope
} from "../context/wakeNotification.js";
import {
  bindExecution,
  claimPending,
  completeProcessing,
  consumePendingBatch,
  mailboxHasWork,
  releaseProcessing,
  type MailboxTarget,
  type WorkMailbox
} from "../coordination/workMailbox.js";
import {
  enqueueWork,
  settleRoleRunDispatch as settleRoleRunDispatchMailbox
} from "../coordination/workMailboxQueue.js";
import { transportAgentResult } from "../domain/agentResultTransport.js";
import { createTaskEvent, type TaskEvent } from "../event/taskEvent.js";
import {
  activeLiveRoleAgentSession,
  bindGlobalRoleProviderRuntime,
  bindTaskRoleProviderRuntime,
  createRoleSessionSet,
  detachRoleAgentSessionHost,
  recordRoleAgentSession,
  recordTaskRoleNativeTurnBoundary,
  rememberRoleAgentCompletedTurn,
  replaceTaskRoleAgentSession,
  selectNewTaskRoleSession,
  taskRoleControlTarget,
  updateGlobalRoleProviderRuntime,
  updateRoleAgentSessionStatus,
  updateTaskRoleProviderRuntime,
  type AgentSessionStatus,
  type GlobalRoleSessionSet,
  type RoleAgentSession,
  type TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import {
  effectiveLaunchWithTaskMainWorkspace,
  resolveEffectiveLaunch,
  roleSessionMayContinue,
  validateEffectiveLaunchSnapshot,
  type EffectiveLaunchSnapshot
} from "../executor/effectiveLaunch.js";
import { answerInputRequest } from "../input/inputRequest.js";
import {
  createCanonicalLifecycleEvent,
  foldCanonicalLifecycleEvent,
  type CanonicalIdentityFence,
  type CanonicalRunExpectation
} from "../lifecycle/canonicalLifecycleEvent.js";
import { cancelQuiescentRoleRuns, terminalizeExactTaskRun } from "../lifecycle/exactRunTerminalization.js";
import {
  markGlobalRoleMessageDelivered,
  markGlobalRoleMessageNotDelivered,
  recordTaskMessageControlOutcome
} from "../message/message.js";
import { snapshotExecutionLaneWorkspaceSync } from "../repository/executionLaneGitSnapshot.js";
import { activeRoleAgentBinding } from "../role/role.js";
import { SYSTEM_OPERATOR_ROLE } from "../role/systemRoles.js";
import type { AgentDriverRegistry } from "../runtime/agentDriver.js";
import { standardAgentError } from "../runtime/agentError.js";
import {
  builtinAgentDriverRegistry
} from "../runtime/builtinAgentDrivers.js";
import {
  RUNTIME_CLEANUP_REQUIRED_REASON,
  RUNTIME_HOST_DETACH_REQUIRED_REASON,
  RUNTIME_LIFECYCLE_OWNER,
  hasRuntimeCleanupObligation,
  hasRuntimeLifecycleWork,
  isRuntimeCleanupReason,
  runtimeCleanupDisposition,
  runtimeLifecycleTarget,
  type RuntimeLifecycleTarget,
  type RuntimeRoleOwner
} from "../runtime/lifecycleReservation.js";
import {
  classifyRuntimeProcessExit,
  validateRuntimeProcessExitObservation
} from "../runtime/processExitObservation.js";
import { providerContinuationKey } from "../runtime/providerContinuation.js";
import {
  acceptProviderTurn,
  beginProviderTurn,
  cancelQuiescentProviderInput,
  clearProviderGoal,
  createProviderRuntimeBinding,
  currentProviderConversation,
  managedProviderTurnId,
  settleProviderTurn,
  settleProviderTurnSubmission,
  supersedeProviderConversation,
  transferProviderAuthority,
  updateProviderConversationRecoverability,
  updateProviderGoal
} from "../runtime/providerRuntimeIdentity.js";
import { projectProviderContinuations } from "../runtime/runtimeContinuationProjection.js";
import {
  RUNTIME_OBSERVATION_TASK_EVENT,
  createRuntimeObservation,
  isRuntimeTokenEvidence,
  runtimeObservationFenceMatches,
  runtimeObservationFromTaskEvent,
  runtimeObservationRunFenceMatches,
  runtimeObservationTaskEventPayload,
  type RuntimeObservation
} from "../runtime/runtimeObservation.js";
import type {
  RuntimeSessionCandidate,
  RuntimeSessionCandidateQuery
} from "../runtime/runtimeSessionCandidate.js";
import { recordLeaderFailure } from "../scheduler/leaderFailure.js";
import {
  recordLeaderAttentionRequired,
  routeRoleEvent
} from "../scheduler/operatorEvent.js";
import type {
  AgentRunProgressFacts,
  DormantRuntimeOwnerCandidate,
  RoleRunDeliveryFailurePersistence,
  RoleRunDeliveryPersistence,
  RoleRunDiagnosticPersistence,
  RoleRunProgressPersistence,
  RoleRunStallPersistence,
  SchedulerMailboxClaimInput, SchedulerMailboxClaimResult,
  SchedulerRole,
  SchedulerRoleSession,
  SchedulerRunProgress,
  SchedulerStorePort
} from "../scheduler/ports.js";
import {
  RUN_DIAGNOSTIC_FINISHED_EVENT,
  RUN_PROGRESS_EVENT,
  RUN_RECOVERED_EVENT,
  RUN_STALLED_EVENT,
  foldRunProgressFacts,
  isRoleRunStalled,
  latestRunDurableProgressAt,
  latestRunEventTime,
  latestStallEvidenceKey
} from "../scheduler/roleRunStall.js";
import { createTaskWake, fallbackWakeCursor, latestTaskWake, markTaskWakeConsumed } from "../scheduler/taskWake.js";
import { wakeReason } from "../scheduler/wakeReason.js";
import { queueLeaderWakeup } from "../scheduler/wakeupQueue.js";
import { pendingWakeupProjection, type TaskStore } from "../storage/taskStore.js";
import {
  formatRunReceiptId
} from "../task/taskRecordReference.js";
import { operationalTaskRecords } from "../task/taskRecordRetirement.js";
import type { RuntimeLifecycleEvent, RuntimeRunTerminalOutcome } from "./runtimeEventInbox.js";
import type {
  ProviderLifecycleObservation
} from "./runtimeEventProcessor.js";

/**
 * One durable revision's read-only facts for one Task. A scheduler pass reads
 * the same revision's large event history once per Task and folds the per-AgentRun
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
  runFacts: ReadonlyMap<string, AgentRunProgressFacts>;
  runs: ReturnType<TaskStore["listRuns"]>;
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
export class AgentHostProviderSessionBusyError extends AgentHostProviderTurnFenceError {
  readonly code = "SESSION_BUSY";
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

  observeAgentHostObservation(event: RuntimeObservationInboxEvent, now = new Date()): ProviderLifecycleObservation {
    // Match canonical ingress: archive and Host fact settlement share the
    // same write boundary, including the original transport envelope.
    return this.store.transaction(() => this.foldAgentHostObservation(event, now));
  }

  private foldAgentHostObservation(event: RuntimeObservationInboxEvent, now: Date): ProviderLifecycleObservation {
    const raw = createRuntimeObservation(event.observation);
    const task = raw.fence.taskId === undefined ? null : this.store.getTask(raw.fence.taskId);
    if (raw.fence.taskId !== undefined && task === null) return "obsolete";
    if (task?.status === "archived") {
      this.observeObsoleteRuntimeEvent({
        eventId: event.id, eventType: event.type, taskId: task.id,
        roleName: raw.fence.roleName, agentId: raw.fence.agentId,
        nativeSessionId: raw.fence.nativeSessionId ?? "unknown",
        reason: "task-archived", originalEvent: event
      }, now);
      return "obsolete";
    }
    if (Date.parse(raw.receivedAt) > now.getTime()) {
      return this.recordObsoleteCanonicalObservation(raw, "received-at-in-future", now);
    }
    let input: RuntimeObservation;
    try {
      if (event.observation.kind === "host.observed") {
        return this.store.transaction(store => {
          const connection = resolveAgentHostObservation(store, event);
          recordAgentHostConnection(store, event, connection, now);
          if (connection.fence.taskId !== undefined) this.persistRuntimeObservation(connection, now);
          return "applied";
        });
      }
      input = resolveAgentHostObservation(this.store, event);
      if (input.kind === "input.accepted" && input.fence.runId === undefined
        && input.fence.receiptId?.startsWith("native-input:")) {
        // A valid ordinary conversation has no managed Run input to mirror.
        // Consuming this fact is not rejection, nor assignment acceptance.
        return "applied";
      }
    } catch (error) {
      if (error instanceof AgentHostObservationDeferred) return "deferred";
      if (!(error instanceof RuntimeHookRunFenceError)) throw error;
      // Rejection is durable diagnostic evidence, never business acceptance.
      return this.recordObsoleteCanonicalObservation(event.observation, error.message, now);
    }
    return this.observeRuntimeObservation(input, now);
  }

  /**
   * Sole provider-independent ingress for structured runtime state. Driver
   * mapping has already happened before this boundary; this method validates
   * the exact durable AgentRun/session fence, applies the small workflow-relevant
   * transitions, and retains the canonical observation for status projection.
   */
  observeRuntimeObservation(
    raw: RuntimeObservation,
    now = new Date()
  ): ProviderLifecycleObservation {
    // Archive and observation settlement share the same write boundary.
    // An ingress read outside this transaction must never authorize clearing
    // a claim after another CLI has committed archive.
    return this.store.transaction(() => this.foldRuntimeObservation(raw, now));
  }

  private foldRuntimeObservation(
    raw: RuntimeObservation,
    now: Date
  ): ProviderLifecycleObservation {
    const input = createRuntimeObservation(raw);
    const taskId = input.fence.taskId;
    if (taskId === undefined) return this.observeGlobalProviderObservation(input, now);
    if (this.store.getTask(taskId)?.status === "archived") {
      return this.recordObsoleteCanonicalObservation(input, "task-archived", now);
    }
    if (Date.parse(input.receivedAt) > now.getTime()) {
      return this.recordObsoleteCanonicalObservation(input, "received-at-in-future", now);
    }
    const adapterId = this.adapterForRuntimeObservation(input);
    if (adapterId === null) {
      return this.recordObsoleteCanonicalObservation(input, "driver-or-turn-mismatch", now);
    }
    if (input.kind === "input.accepted" && input.payload.input !== undefined
      && (input.fence.receiptId?.startsWith("native-input:") === true
        || input.fence.receiptId?.startsWith("steer:") === true)) {
      return this.store.transaction((store) => {
        const run = input.fence.runId === undefined ? null : store.getRun(taskId, input.fence.runId);
        const sessions = store.getTaskRoleSessionSet(taskId, input.fence.roleName);
        const native = sessions?.providerBinding?.run;
        const isSteer = input.fence.receiptId!.startsWith("steer:");
        // A Worker/Reviewer steer's accepted input is folded onto the owning
        // AgentRun. A no-Run Leader steer (decision-3 §9) has no run to append to,
        // but its accepted disposition is still a real fact that gap D records on
        // the Message; only the Worker append requires the exact Run/Turn fence.
        const runFolded = run !== null && run.roleName === input.fence.roleName
          && run.effective.agentId === input.fence.agentId && native?.runId === run.id
          && native.nativeTurnId === input.fence.nativeTurnId
          && sessions?.sessions[input.fence.agentId]?.nativeSessionId === input.fence.nativeSessionId;
        if (!runFolded && !(isSteer && input.fence.runId === undefined)) return "obsolete";
        if (runFolded && !hasPersistedRuntimeObservation(store.listEvents(taskId), input) && run!.status === "active") {
          const updated = appendRunInput(run!, createRunInput({
            source: input.fence.receiptId!.startsWith("native-input:")
              ? { type: "provider", channel: "visible-input" }
              : { type: "yui", channel: "input-response" },
            directive: input.payload.input!, deltaRefIds: []
          }), now);
          store.saveRun(updated);
          store.saveActiveRun(updated);
        }
        // decision-3 §3/§8, message-5 gap D: promote the Message's independent
        // control op to its proven terminal from the Host's own settlement, keyed
        // by this exact steer receipt. Monotonic and idempotent — never a rewind
        // of an already-proven outcome, and a replayed observation is absorbed.
        if (isSteer) this.recordSteerControlOutcome(store, input.fence.receiptId!, "accepted", now);
        this.persistRuntimeObservation(input, now);
        return "applied";
      });
    }
    // A steer's rejected/delivery-unknown disposition is the Host's proven
    // terminal for the one live control attempt (message-5 gap D). It carries no
    // AgentRun append — a rejected input changed no execution — so it is recorded
    // only on the Message's control op, for a Worker/Reviewer or a no-Run Leader
    // steer alike, keyed by the exact steer receipt.
    if ((input.kind === "input.rejected" || input.kind === "input.delivery-unknown")
      && input.fence.receiptId?.startsWith("steer:") === true) {
      return this.store.transaction((store) => {
        if (hasPersistedRuntimeObservation(store.listEvents(taskId), input)) return "applied";
        const recorded = this.recordSteerControlOutcome(store, input.fence.receiptId!,
          input.kind === "input.rejected" ? "rejected" : "delivery-unknown", now);
        if (!recorded) {
          recordCanonicalObservationObsolete(store, input, "steer-message-not-found", now);
          return "obsolete";
        }
        this.persistRuntimeObservation(input, now);
        return "applied";
      });
    }
    if ((input.kind === "input.accepted" || input.kind === "input.rejected" || input.kind === "input.delivery-unknown")
      && input.payload.input !== undefined
      && input.fence.receiptId?.startsWith("turn-input:") === true) {
      return this.observeLeaderSteerReceipt(input, now);
    }
    // Receipt dedupe is not business-result dedupe. Terminal folds revalidate
    // their exact binding and commit result + notification + observation
    // together, including a retry after a previously interrupted fold.
    if (!isRunTerminalObservation(input)
      && input.kind !== "turn.accepted" && input.kind !== "input.accepted"
      && hasPersistedRuntimeObservation(this.store.listEvents(taskId), input)) return "applied";
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
        // Keep the AgentRun and Session identity available for Agent-directed
        // restore + submit, even when a provider marks its AgentRun terminal.
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
        outcome = this.validateCanonicalRunObservation(input, now);
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
    if (outcome === "applied" && !isRunTerminalObservation(input)) {
      this.persistRuntimeObservation(input, now);
    }
    return outcome;
  }

  /**
   * Promote a steer Message's independent control op to a proven outcome from the
   * Host's own settlement (decision-3 §3/§8, message-5 gap D). The `steer:` fence
   * names the exact `steer:<taskId>/<messageId>` receipt, so the outcome binds to
   * that one Message and never another; the requestId is read from the Message's
   * own steer identity (its live input, or the reused-steer provenance a handoff
   * preserved) so the recorded op matches the same idempotency key the live edge
   * used. Returns false when the receipt names no such steer Message, so the
   * caller can mark the observation obsolete rather than silently drop it. The
   * record is monotonic and idempotent inside {@link recordTaskMessageControlOutcome}.
   */
  private recordSteerControlOutcome(
    store: TaskStore, receiptId: string,
    outcome: "accepted" | "rejected" | "delivery-unknown", now: Date
  ): boolean {
    const parsed = /^steer:([^/]+)\/(.+)$/.exec(receiptId);
    if (parsed === null) return false;
    const [, taskId, messageId] = parsed;
    const message = store.listMessages(taskId).find((entry) => entry.id === messageId);
    const requestId = message?.inputControl?.requestId ?? message?.interruptThen?.reusedInput?.requestId;
    const wasSteer = message?.inputControl?.action === "steer"
      || message?.interruptThen?.reusedInput?.action === "steer";
    if (message === undefined || requestId === undefined || !wasSteer) return false;
    const recorded = recordTaskMessageControlOutcome(message, {
      requestId, receiptId, outcome, observedAt: now
    });
    // The monotonic guard returns the same Message when the record is absorbed
    // (an idempotent repeat, or a stale outcome that must not rewind a proven
    // terminal); only persist a real change.
    if (recorded !== message) store.updateMessage(taskId, recorded);
    return true;
  }

  /** A delayed steer receipt settles only its original claimed mailbox batch. */
  private observeLeaderSteerReceipt(
    input: RuntimeObservation,
    now: Date
  ): ProviderLifecycleObservation {
    return this.store.transaction((store) => {
      const taskId = input.fence.taskId!;
      const run = input.fence.runId === undefined ? null : store.getRun(taskId, input.fence.runId);
      const sessions = store.getTaskRoleSessionSet(taskId, input.fence.roleName);
      const session = sessions?.sessions[input.fence.agentId];
      const binding = sessions?.providerBinding;
      if (run === null || run.roleName !== "leader" || input.fence.roleName !== "leader"
        || run.effective.agentId !== input.fence.agentId
        || session === undefined
        || session.nativeSessionId !== input.fence.nativeSessionId
        || binding?.run?.runId !== run.id
        || binding.run.nativeTurnId !== input.fence.nativeTurnId) {
        recordCanonicalObservationObsolete(store, input, "steer-receipt-fence-mismatch", now);
        return "obsolete";
      }
      if (hasPersistedRuntimeObservation(store.listEvents(taskId), input)) return "applied";
      const target = { kind: "role", taskId, roleName: "leader" } as const;
      const mailbox = store.getWorkMailbox(target);
      const processing = mailbox?.processing;
      const exactBatch = processing?.owner === `leader-steer:${run.id}`
        && input.fence.receiptId === `turn-input:${taskId}/${run.id}/${processing.batchId}`;
      if (exactBatch && mailbox !== null && processing !== null && processing !== undefined) {
        if (input.kind === "input.accepted") {
          // Terminal AgentRuns remain immutable: the canonical receipt still
          // retains their late input, without touching a successor pointer.
          if (run.status === "active" && store.getActiveRun(taskId, "leader")?.id === run.id) {
            const updated = appendRunInput(run, createRunInput({
              source: { type: "yui", channel: "leader-forced-wakeup" },
              directive: input.payload.input!,
              deltaRefIds: []
            }), now);
            store.saveRun(updated);
            store.saveActiveRun(updated);
          }
          store.saveWorkMailbox(completeProcessing(mailbox, processing.batchId));
          store.saveEvent(taskId, createTaskEvent(store.nextEventId(taskId), taskId, "run.input-submitted", {
            runId: run.id,
            batchId: processing.batchId,
            attemptId: input.fence.receiptId!,
            source: "yui/leader-forced-wakeup",
            reasons: processing.batch.reasons.join(",")
          }, now));
        } else if (input.payload.failure?.error.inputDisposition === "not-accepted") {
          store.saveWorkMailbox(releaseProcessing(mailbox, processing.batchId));
        }
      }
      if (input.kind !== "input.accepted" && input.payload.failure !== undefined) {
        const error = input.payload.failure.error;
        this.recordAgentError({
          taskId, roleName: run.roleName, runId: run.id,
          source: error.source, phase: error.phase,
          message: error.message, raw: error.raw,
          inputDisposition: error.inputDisposition,
          sessionDisposition: error.sessionDisposition,
          attemptId: input.fence.receiptId
        }, now);
      }
      this.persistRuntimeObservation(input, now);
      return "applied";
    });
  }

  private observeGlobalProviderObservation(input: RuntimeObservation, now: Date): ProviderLifecycleObservation {
    return this.store.transaction((store) => {
      const fence = input.fence;
      let sessions = store.getGlobalRoleSessionSet(fence.roleName);
      const session = sessions?.sessions[fence.agentId];
      let binding = sessions?.providerBinding;
      if (sessions == null || session == null || binding == null || fence.runId !== undefined
        || sessions.activeAgentId !== fence.agentId
        || session.nativeSessionId !== fence.nativeSessionId
        || this.drivers.requireByAdapterId(session.adapterId).id !== fence.driverId
        || currentProviderConversation(binding).conversationId !== fence.nativeSessionId
        || Date.parse(input.receivedAt) > now.getTime()) return "obsolete";
      const at = input.observedAt ?? input.receivedAt;
      const receipt = fence.receiptId;
      const matches = receipt !== undefined && binding.run?.attemptId === receipt
        && (fence.nativeTurnId === undefined || binding.run.nativeTurnId === undefined
          || binding.run.nativeTurnId === fence.nativeTurnId);
      if (input.kind === "turn.accepted") {
        if (input.authority === "transport" && matches) {
          const message = store.listGlobalRoleMessages(fence.roleName).find(entry =>
            receipt === `global-input:${fence.roleName}/${entry.id}`);
          if (message !== undefined) store.updateGlobalRoleMessage(
            markGlobalRoleMessageDelivered(message, new Date(at), "transport"));
          return "applied";
        }
        if (input.authority !== "provider-structured") return "applied";
        if (!matches) {
          if (receipt?.startsWith("direct:") !== true || binding.run != null
            && ["submitting", "accepted", "delivery-unknown"].includes(binding.run.status)) return "obsolete";
          binding = beginProviderTurn(binding, { attemptId: receipt,
            authorityEpoch: binding.authority.epoch, submittedAt: at });
        }
        if (binding.run?.status === "submitting" || binding.run?.status === "delivery-unknown") {
          binding = acceptProviderTurn(binding, { attemptId: receipt!,
            nativeTurnId: fence.nativeTurnId, acceptedAt: at });
        } else if (binding.run?.status !== "accepted") return "applied";
        const message = store.listGlobalRoleMessages(fence.roleName).find(entry =>
          receipt === `global-input:${fence.roleName}/${entry.id}`
          || binding?.retry?.currentAttemptId === receipt && binding.retry.input.kind === "message"
            && binding.retry.input.messageId === entry.id);
        if (message !== undefined) store.updateGlobalRoleMessage(markGlobalRoleMessageDelivered(message, new Date(at)));
      } else if (["turn.completed", "turn.cancelled", "turn.failed"].includes(input.kind)) {
        if (!matches || input.authority !== "provider-structured") return "obsolete";
        // A provider final result proves this exact submitted input ran (Claude
        // may emit its result without an earlier assistant acceptance event).
        // Process exit/failure alone must not turn unconfirmed input into proof.
        if (input.kind === "turn.completed" && binding.run != null
          && ["submitting", "delivery-unknown"].includes(binding.run.status)) {
          binding = acceptProviderTurn(binding, { attemptId: receipt!, nativeTurnId: fence.nativeTurnId, acceptedAt: at });
          const message = store.listGlobalRoleMessages(fence.roleName).find(entry =>
            receipt === `global-input:${fence.roleName}/${entry.id}`
            || binding?.retry?.currentAttemptId === receipt && binding.retry.input.kind === "message"
              && binding.retry.input.messageId === entry.id);
          if (message !== undefined) store.updateGlobalRoleMessage(markGlobalRoleMessageDelivered(message, new Date(at)));
        }
        if (binding.run?.status !== "accepted") return binding.run != null
          && ["completed", "cancelled", "failed"].includes(binding.run.status) ? "applied" : "obsolete";
        binding = settleProviderTurn(binding, { attemptId: receipt, nativeTurnId: fence.nativeTurnId,
          status: input.kind === "turn.completed" ? "completed" : input.kind === "turn.cancelled" ? "cancelled" : "failed",
          settledAt: at });
        if (fence.nativeTurnId !== undefined) sessions = rememberRoleAgentCompletedTurn(
          sessions, fence.agentId, fence.nativeSessionId!, fence.nativeTurnId, new Date(at));
      } else if (["input.accepted", "input.rejected", "input.delivery-unknown"].includes(input.kind)) {
        if (input.authority !== "provider-structured" || binding.run?.nativeTurnId !== fence.nativeTurnId
          || binding.run?.status !== "accepted") return "obsolete";
        const message = store.listGlobalRoleMessages(fence.roleName).find(entry =>
          receipt === `steer:${fence.roleName}/${entry.id}`);
        if (message !== undefined && message.inputControl !== undefined) {
          const outcome = input.kind === "input.accepted" ? "accepted"
            : input.kind === "input.rejected" ? "rejected" : "delivery-unknown";
          if (message.control?.outcome !== "accepted" && message.control?.outcome !== "rejected") {
            const updated = { ...message, control: { requestId: message.inputControl.requestId,
              receiptId: receipt!, outcome, observedAt: at } } as typeof message;
            store.updateGlobalRoleMessage(outcome === "accepted"
              ? markGlobalRoleMessageDelivered(updated, new Date(at)) : updated);
          }
        }
      } else if (input.kind === "conversation.observed" && input.payload.recoverability !== undefined) {
        binding = updateProviderConversationRecoverability(binding, input.payload.recoverability);
      }
      if (input.kind === "turn.failed" && matches && input.payload.failure !== undefined) {
        binding = recordProviderFailure(binding, {
          error: input.payload.failure.error, failureRef: input.eventId, at: now.getTime()
        });
      }
      store.saveGlobalRoleSessionSet(updateGlobalRoleProviderRuntime(sessions, binding, now));
      settleGlobalRetryInput(store, fence.roleName, binding, now);
      return "applied";
    });
  }

  private adapterForRuntimeObservation(
    input: RuntimeObservation
  ): string | null {
    const taskId = input.fence.taskId;
    const runId = input.fence.runId;
    if (taskId === undefined) return null;
    if (runId === undefined) {
      const role = this.store.getRole(taskId, input.fence.roleName);
      const sessions = this.store.getTaskRoleSessionSet(taskId, input.fence.roleName);
      const session = sessions?.sessions[input.fence.agentId];
      if (role === null || sessions?.activeAgentId !== input.fence.agentId
        || session?.adapterId === undefined) return null;
      try {
        return this.drivers.requireByAdapterId(session.adapterId).id === input.fence.driverId
          ? session.adapterId
          : null;
      } catch {
        return null;
      }
    }
    const run = this.store.getRun(taskId, runId);
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
      if (hasPersistedRuntimeObservation(store.listEvents(input.fence.taskId!), input)) {
        return "applied";
      }
      const run = input.fence.runId === undefined ? null : store.getRun(input.fence.taskId!, input.fence.runId);
      const active = store.getActiveRun(input.fence.taskId!, input.fence.roleName);
      const sessions = store.getTaskRoleSessionSet(input.fence.taskId!, input.fence.roleName);
      const session = sessions?.sessions[input.fence.agentId];
      if (input.fence.runId === undefined
        && ["operation.started", "operation.completed", "operation.failed", "activity.observed"].includes(input.kind)) {
        const native = sessions?.providerBinding?.run;
        return native?.runId === undefined && input.fence.receiptId !== undefined
          && native?.attemptId === input.fence.receiptId && native.status === "accepted"
          && session?.nativeSessionId === input.fence.nativeSessionId
          && (native.nativeTurnId === undefined || native.nativeTurnId === input.fence.nativeTurnId)
          ? "applied" : "obsolete";
      }
      const knownContinuation = input.kind.startsWith("continuation.") && projectProviderContinuations(store.listEvents(input.fence.taskId!)).some((entry) => (
          entry.runId === input.fence.runId
          && entry.identity.providerNamespace === input.fence.driverId
          && entry.identity.accountScope === input.fence.agentId
          && entry.identity.conversationId === input.fence.conversationId
          && entry.identity.continuationId === input.fence.continuationId
        ));
      const requiresCurrentRuntime = input.kind !== "turn.cancelled" && !knownContinuation;
      const valid = run !== null && (!requiresCurrentRuntime || (run.status === "active" && active?.id === run.id)) && run.roleName === input.fence.roleName && run.effective.agentId === input.fence.agentId && this.drivers.requireByAdapterId(run.effective.adapterId).id === input.fence.driverId && (knownContinuation || (session !== undefined && session.nativeSessionId === input.fence.nativeSessionId)) && runtimeReceiptBelongsToRun(store, input);
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
      ? input.payload.resultTransportDiagnostic === undefined
        ? transportAgentResult(input.payload.output)
        : {
            status: "failed" as const,
            diagnostic: input.payload.resultTransportDiagnostic,
            failureReason: "runtime-failed" as const
          }
      : {
          status: "failed" as const,
          ...(typeof input.payload.output === "string"
            && transportAgentResult(input.payload.output).status === "completed"
            ? { output: input.payload.output } : {}),
          diagnostic: providerStatus === "cancelled"
            ? "Provider cancelled the Agent AgentRun."
            : `Provider Agent AgentRun failed: ${input.payload.failure?.error.message ?? "unknown provider failure"}`,
          failureReason: providerStatus === "cancelled"
            ? "cancelled" as const
            : "runtime-failed" as const
        };
    const completed = {
      taskId: input.fence.taskId!,
      roleName: input.fence.roleName,
      agentId: input.fence.agentId,
      adapterId,
      conversationId: input.fence.conversationId,
      nativeSessionId: input.fence.nativeSessionId!,
      nativeTurnId: input.fence.nativeTurnId,
      attemptId: input.fence.receiptId,
      runId: input.fence.runId,
      ...(input.payload.input === undefined ? {} : { input: input.payload.input }),
      providerStatus,
      outcome,
      observation: input
    };
    const classification = this.classifyRuntimeRunTerminal(completed);
    if (classification !== "apply") return classification;
    const result = this.observeRuntimeRunTerminal(completed, now);
    return result.disposition === "obsolete" ? "obsolete" : "applied";
  }

  private validateCanonicalSessionObservation(
    input: RuntimeObservation,
    now: Date
  ): ProviderLifecycleObservation {
    return this.store.transaction((store) => {
      const run = input.fence.runId === undefined ? null : store.getRun(input.fence.taskId!, input.fence.runId);
      const sessions = store.getTaskRoleSessionSet(input.fence.taskId!, input.fence.roleName);
      const session = sessions?.sessions[input.fence.agentId];
      const native = sessions?.providerBinding?.run;
      const exactInput = input.fence.receiptId !== undefined && native?.attemptId === input.fence.receiptId;
      const validRun = input.fence.runId === undefined ? exactInput
        : run !== null && run.roleName === input.fence.roleName && run.effective.agentId === input.fence.agentId
          && this.drivers.requireByAdapterId(run.effective.adapterId).id === input.fence.driverId;
      if (!validRun || session === undefined || session.nativeSessionId !== input.fence.nativeSessionId
        || (input.fence.receiptId !== undefined && (!exactInput
          || (native?.nativeTurnId !== undefined && native.nativeTurnId !== input.fence.nativeTurnId)))) {
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
      store.saveTaskRoleSessionSet(updatedSessions);
      for (const continuation of projectProviderContinuations(
        store.listEvents(input.fence.taskId!)
      )) {
        if (continuation.runId !== input.fence.runId || continuation.identity.conversationId
            !== (input.fence.conversationId ?? input.fence.nativeSessionId) || continuation.execution === "quiescent" || continuation.attachment === "detached") continue;
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
            continuationId: continuation.identity.continuationId,
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
      const active = store.getActiveRun(input.fence.taskId!, input.fence.roleName);
      const role = store.getRole(input.fence.taskId!, input.fence.roleName);
      if ((input.kind === "session.ended" || input.kind === "session.failed")
        && active !== null
        && active.id === input.fence.runId
        && active.status === "active"
        && role !== null) {
        if (role.name === "leader") {
          const message = [
            `Leader native Session became unavailable while AgentRun ${active.id} remains active.`,
            "Yui preserved the AgentRun because Session/host termination is not a Task outcome.",
            "Retire the disposable AgentRun, or use Task execution stop/start if the current runtime cannot be settled normally."
          ].join(" ");
          recordLeaderAttentionRequired(store, {
            taskId: input.fence.taskId!,
            reason: "leader-runtime-detached",
            payload: { message, runId: active.id },
            now
          });
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
          if (continuation.runId !== input.fence.runId || continuation.identity.conversationId !== input.fence.conversationId || continuation.execution === "quiescent") continue;
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
        const run = input.fence.runId === undefined
          ? null
          : store.getRun(taskId, input.fence.runId);
        const errorEvent = createTaskEvent(
          store.nextEventId(taskId),
          taskId,
          "runtime.agent-error",
          {
            sourceEventId: input.eventId,
            observationEventId,
            runId: input.fence.runId ?? "",
            roleName: input.fence.roleName,
            agentId: input.fence.agentId,
            adapterId: run?.effective.adapterId ?? "unknown",
            driverId: input.fence.driverId,
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
        if (!providerRetryPending(store.getTaskRoleSessionSet(taskId, input.fence.roleName)?.providerBinding)) routeRoleEvent(
          store,
          errorEvent,
          input.fence.roleName,
          wakeReason("agent-error", errorEvent.id),
          now
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
    if (this.telemetry !== null && input.fence.runId !== undefined) {
      try {
        const entry = runtimeObservationTelemetryEntry(input);
        this.telemetry.sink.observe(entry);
        const run = this.store.getRun(entry.taskId, input.fence.runId);
        if (run !== null && run.status !== "active") {
          void this.telemetry.retention.flush().then(() => {
            this.telemetry?.retention.pruneRun(
              entry.taskId,
              entry.roleName,
              entry.runId
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
        runs: this.store.listRuns(taskId),
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
  listPlanningDraftTaskIds(): readonly string[] {
    return [...this.store.listPlanningDraftTaskIds()].sort((left, right) => (
      left.localeCompare(right, undefined, { numeric: true })
    ));
  }
  listPendingActivationRequestTaskIds(): readonly string[] {
    return [...this.store.listPendingActivationRequestTaskIds()].sort((left, right) => (
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
          reader.listRuns(taskId),
          reader.listEvents(taskId),
          "run"
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

  getActiveRun(taskId: string, roleName: string) {
    return this.store.getActiveRun(taskId, roleName);
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

  markOperatorRunStarted(now: Date): void {
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

  listRuns(taskId: string) {
    return this.#taskReadProjection(taskId).runs;
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

  getRunProgressFacts(taskId: string, runId: string): AgentRunProgressFacts | undefined {
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
    // are read once per Task per revision, and the per-AgentRun checkpoint/activity
    // facts come from the one-pass fold instead of per-candidate scans.
    const view = {
      getRun: (id: string, runId: string) => this.store.getRun(id, runId),
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
    return latestRunDurableProgressAt(view, taskId, roleName, runId, projected.runFacts.get(runId) ?? {});
  }

  recordRoleRunDiagnostic(
    input: RoleRunDiagnosticPersistence
  ): "recorded" | "already-recorded" | "state-changed" {
    return this.store.transaction((store) => {
      const task = store.getTask(input.taskId);
      const run = store.getActiveRun(input.taskId, input.roleName);
      if (task === null || run === null || !runPurposeAdmitsTaskState(run.purpose, task)
        || run.id !== input.runId || run.status !== "active") {
        return "state-changed";
      }
      const latest = latestRunEventTime(
        store.listEvents(input.taskId),
        RUN_DIAGNOSTIC_FINISHED_EVENT,
        input.runId
      );
      if (latest !== undefined && Date.parse(latest) >= Date.parse(input.startedAt)) {
        return "already-recorded";
      }
      store.saveEvent(input.taskId, createTaskEvent(
        store.nextEventId(input.taskId),
        input.taskId,
        RUN_DIAGNOSTIC_FINISHED_EVENT,
        {
          runId: input.runId,
          roleName: input.roleName,
          outcome: input.outcome,
          startedAt: input.startedAt
        },
        input.now
      ));
      return "recorded";
    });
  }

  recordRoleRunStall(
    input: RoleRunStallPersistence
  ): "raised" | "already-raised" | "state-changed" {
    return this.store.transaction((store) => {
      const task = store.getTask(input.taskId);
      const role = store.getRole(input.taskId, input.roleName);
      const run = store.getActiveRun(input.taskId, input.roleName);
      if (
        task === null
        || role === null
        || run === null
        || !runPurposeAdmitsTaskState(run.purpose, task)
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
          status: "diagnostic-only"
        },
        input.now
      );
      store.saveEvent(task.id, event);
      return "raised";
    });
  }

  recordRoleRunProgress(
    input: RoleRunProgressPersistence
  ): "recorded" | "already-recorded" | "state-changed" {
    return this.store.transaction((store) => {
      const task = store.getTask(input.taskId);
      const run = store.getActiveRun(input.taskId, input.roleName);
      if (
        task === null
        || run === null
        || !runPurposeAdmitsTaskState(run.purpose, task)
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
      // Advisory 30-minute diagnostics are intentionally not lifecycle
      // episodes and therefore must never synthesize turn.recovered.
      const recovered = isRoleRunStalled(events, run.id);
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
      }
      return existing && !recovered ? "already-recorded" : "recorded";
    });
  }

  beginAgentHostProviderTurn(input: Readonly<{
    taskId?: string;
    roleName: string;
    runId?: string;
    agentId: string;
    nativeSessionId: string;
    attemptId: string;
    authorityEpoch: number;
    authorityOwner: "controller" | "human";
    holderId: string;
    now: Date;
    boundedText?: string;
    retrySupported?: boolean;
  }>): void {
    if (input.taskId === undefined) {
      this.store.transaction((store) => {
        if (input.runId !== undefined || hasRuntimeCleanupObligation(store.getWorkMailbox(
          runtimeLifecycleTarget({ scope: "global", roleName: input.roleName })))) {
          throw new AgentHostProviderTurnFenceError("Global Session admission is stopped.");
        }
        const sessions = store.getGlobalRoleSessionSet(input.roleName);
        let binding = sessions?.providerBinding;
        const session = sessions?.sessions[input.agentId];
        if (sessions === null || binding == null || session === undefined
          || sessions.activeAgentId !== input.agentId || session.status !== "active"
          || session.nativeSessionId !== input.nativeSessionId
          || currentProviderConversation(binding).conversationId !== input.nativeSessionId
          || binding.authority.owner !== input.authorityOwner
          || binding.authority.epoch !== input.authorityEpoch
          || binding.authority.holderId !== input.holderId) {
          throw new AgentHostProviderTurnFenceError("Global input carries a stale Session or writer fence.");
        }
        const turn = binding.run;
        if (turn?.attemptId === input.attemptId && turn.status === "submitting") {
          admitOwnedProviderInput(store, binding, input);
          return;
        }
        if (turn != null && ["submitting", "accepted", "delivery-unknown"].includes(turn.status)) {
          throw new AgentHostProviderSessionBusyError("Global Conversation has an unsettled input.");
        }
        const message = store.listGlobalRoleMessages(input.roleName).find(entry =>
          input.attemptId === `global-input:${input.roleName}/${entry.id}`);
        const reserved = store.listGlobalRoleMessages(input.roleName).find(entry =>
          entry.delivery === undefined && entry.notDelivered === undefined
          && entry.interruptThen?.targetNativeSessionId === input.nativeSessionId
          && entry.interruptThen.targetAgentId === input.agentId
          && entry.interruptThen.targetAuthorityEpoch === input.authorityEpoch
          && entry.interruptThen.targetAuthorityHolderId === input.holderId);
        if (reserved !== undefined && reserved.id !== message?.id) {
          throw new AgentHostProviderSessionBusyError("The next Global input belongs to an explicit then handoff.");
        }
        if (message !== undefined) {
          if (message.delivery !== undefined || message.notDelivered !== undefined
            || message.control !== undefined && message.control.outcome !== "rejected"
            || message.deliveryTarget?.agentId !== input.agentId
            || message.deliveryTarget?.nativeSessionId !== input.nativeSessionId) {
            throw new AgentHostProviderTurnFenceError("Global Message is settled, unconfirmed, or bound to another Session.");
          }
          const claim = message.interruptThen;
          if (claim !== undefined && (claim.targetAgentId !== input.agentId
            || claim.targetNativeSessionId !== input.nativeSessionId
            || claim.targetAuthorityEpoch !== input.authorityEpoch
            || claim.targetAuthorityHolderId !== input.holderId
            || turn?.attemptId !== claim.targetAttemptId
            || !["completed", "failed", "cancelled"].includes(turn.status))) {
            throw new AgentHostProviderTurnFenceError("Global then target no longer has exact terminal proof.");
          }
          store.updateGlobalRoleMessage({ ...message, control: {
            requestId: message.inputControl?.requestId ?? message.interruptThen!.requestId,
            receiptId: input.attemptId, outcome: "pending", observedAt: input.now.toISOString()
          } });
        }
        binding = admitOwnedProviderInput(store, binding, input);
        store.saveGlobalRoleSessionSet(updateGlobalRoleProviderRuntime(sessions,
          beginProviderTurn(binding, { attemptId: input.attemptId,
            input: binding.retry?.currentAttemptId === input.attemptId ? binding.retry.input : ownedProviderInput(input),
            retrySupported: input.retrySupported,
            authorityEpoch: input.authorityEpoch, submittedAt: input.now.toISOString() }), input.now));
      });
      return;
    }
    this.beginTaskAgentHostProviderTurn({ ...input, taskId: input.taskId });
  }

  private beginTaskAgentHostProviderTurn(input: Readonly<{
    taskId: string; roleName: string; runId?: string; agentId: string;
    nativeSessionId: string; attemptId: string; authorityEpoch: number;
    authorityOwner: "controller" | "human"; holderId: string; now: Date;
    boundedText?: string; retrySupported?: boolean;
  }>): void {
    this.store.transaction((store) => {
      const task = store.getTask(input.taskId);
      if (task === null || !["active", "draft"].includes(task.status) || task.executionGate.state !== "enabled"
        || hasRuntimeCleanupObligation(store.getWorkMailbox(runtimeLifecycleTarget({
          scope: "task", taskId: input.taskId, roleName: input.roleName
        })))) {
        throw new AgentHostProviderTurnFenceError("Session execution admission is stopped or being replaced.");
      }
      const sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName);
      const session = sessions?.sessions[input.agentId];
      let binding = sessions?.providerBinding;
      const active = store.getActiveRun(input.taskId, input.roleName);
      if (sessions === null || sessions === undefined || binding === null || binding === undefined || (input.runId !== undefined && (active?.id !== input.runId || active.effective.agentId !== input.agentId)) || session === undefined || session.nativeSessionId !== input.nativeSessionId || currentProviderConversation(binding).conversationId !== input.nativeSessionId || binding.authority.owner !== input.authorityOwner || binding.authority.epoch !== input.authorityEpoch || binding.authority.holderId !== input.holderId) {
        throw new AgentHostProviderTurnFenceError(
          "Agent Host Provider Turn carries a stale durable writer fence. Release and reacquire Provider authority before retrying input."
        );
      }
      const currentRun = binding.run;
      if (session.effective.executionEnvironment !== undefined) {
        assertExecutionEnvironmentCurrent(store, input.taskId, session.effective.executionEnvironment);
      }
      if (input.runId !== undefined
        && !isDeepStrictEqual(active?.effective.executionEnvironment, session.effective.executionEnvironment)) {
        throw new AgentHostProviderTurnFenceError("AgentRun and native Session execution environments differ; start a new Session.");
      }
      if (input.runId !== undefined
        && active?.effective.executionAuthority !== session.effective.executionAuthority) {
        throw new AgentHostProviderTurnFenceError("Execution authority differs from the fixed native Session.");
      }
      const exactReplay = currentRun !== null
        && currentRun.runId === input.runId
        && currentRun.attemptId === input.attemptId
        && currentRun.authorityEpoch === input.authorityEpoch
        && currentRun.status === "submitting";
      if (!exactReplay && binding.run !== null
        && ["submitting", "accepted", "delivery-unknown"]
          .includes(binding.run.status)) {
        throw new AgentHostProviderSessionBusyError(
          "Provider Conversation already has an unsettled AgentRun."
        );
      }
      if (!exactReplay) {
        const claims = store.listMessages(input.taskId).filter(message =>
          message.interruptThen?.targetRoleName === input.roleName
          && message.interruptThen.targetNativeSessionId === input.nativeSessionId
          && message.interruptThen.targetAgentId === input.agentId
          && message.interruptThen.targetAuthorityEpoch === input.authorityEpoch
          && message.interruptThen.targetAuthorityHolderId === input.holderId
          && message.interruptThen.notDeliveredReason === undefined
          && message.continuation?.notDeliveredReason === undefined);
        for (const message of claims) {
          if (input.roleName === "leader") {
            const wakes = store.listTaskWakes(input.taskId).filter(wake =>
              wake.refs?.some(ref => ref.type === "message" && ref.id === message.id));
            if (wakes.some(wake => wake.status === "consumed")) continue;
            const mailbox = store.getWorkMailbox({ kind: "role", taskId: input.taskId, roleName: "leader" });
            const selected = wakes.some(wake => mailbox?.processing?.owner === `leader-notification:${wake.id}`
              && mailbox.processing.batchId === input.attemptId);
            if (!selected) throw new AgentHostProviderSessionBusyError("The next Leader input belongs to an explicit then handoff.");
          } else {
            const continuationId = message.continuation?.runId;
            const continuation = continuationId === undefined ? null : store.getRun(input.taskId, continuationId);
            if (continuation !== null && (continuation.status !== "active" || currentRun?.runId === continuation.id)) continue;
            if (input.runId !== continuationId || continuationId === undefined) {
              throw new AgentHostProviderSessionBusyError("The next execution input belongs to an explicit then handoff.");
            }
          }
        }
      }
      binding = admitOwnedProviderInput(store, binding, input);
      store.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(
        sessions,
        beginProviderTurn(binding, {
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          attemptId: input.attemptId,
          authorityEpoch: input.authorityEpoch,
          submittedAt: input.now.toISOString(),
          input: binding.retry?.currentAttemptId === input.attemptId ? binding.retry.input : ownedProviderInput(input),
          retrySupported: input.retrySupported
        }),
        input.now
      ));
    });
  }

  resolveAgentHostProviderTurnSubmission(input: Readonly<{
    taskId?: string;
    roleName: string;
    runId?: string;
    attemptId: string;
    status: "rejected" | "deferred" | "delivery-unknown";
    reason: string;
    raw: string;
    now: Date;
    noProviderWrite?: boolean;
  }>): void {
    if (input.taskId === undefined) {
      this.store.transaction((store) => {
        const sessions = store.getGlobalRoleSessionSet(input.roleName);
        const binding = sessions?.providerBinding;
        if (input.runId !== undefined || sessions == null || binding?.run?.attemptId !== input.attemptId) {
          throw new Error("Global input submission is no longer current.");
        }
        let resolved = settleProviderTurnSubmission(binding, { attemptId: input.attemptId, status: input.status,
          reason: input.reason, resolvedAt: input.now.toISOString() });
        resolved = this.retrySubmissionResolution(resolved, input, sessions.sessions[sessions.activeAgentId]?.adapterId);
        store.saveGlobalRoleSessionSet(updateGlobalRoleProviderRuntime(sessions, resolved, input.now));
        settleGlobalRetryInput(store, input.roleName, resolved, input.now);
        const message = store.listGlobalRoleMessages(input.roleName).find(entry =>
          input.attemptId === `global-input:${input.roleName}/${entry.id}`);
        if (message !== undefined && message.delivery?.via !== "provider") {
          const outcome = input.status === "delivery-unknown" ? "delivery-unknown" : "rejected";
          const updated = { ...message, control: {
            requestId: message.inputControl?.requestId ?? message.interruptThen!.requestId,
            receiptId: input.attemptId, outcome, observedAt: input.now.toISOString()
          } } as typeof message;
          store.updateGlobalRoleMessage(input.status === "rejected" && updated.delivery === undefined && !providerRetryPending(resolved)
            ? markGlobalRoleMessageNotDelivered(updated, input.reason, input.now) : updated);
        }
      });
      return;
    }
    this.resolveTaskAgentHostProviderTurnSubmission({ ...input, taskId: input.taskId });
  }

  private resolveTaskAgentHostProviderTurnSubmission(input: Readonly<{
    taskId: string; roleName: string; runId?: string; attemptId: string;
    status: "rejected" | "deferred" | "delivery-unknown"; reason: string; raw: string; now: Date;
    noProviderWrite?: boolean;
  }>): void {
    this.store.transaction((store) => {
      const sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName);
      const binding = sessions?.providerBinding;
      if (sessions === null || sessions === undefined
        || binding === null || binding === undefined
        || binding.run?.runId !== input.runId
        || binding.run?.attemptId !== input.attemptId) {
        throw new Error("Agent Host Provider Turn submission is no longer current.");
      }
      let updated = settleProviderTurnSubmission(binding, {
        attemptId: input.attemptId,
        status: input.status,
        reason: input.reason,
        resolvedAt: input.now.toISOString()
      });
      updated = this.retrySubmissionResolution(updated, input, sessions.sessions[sessions.activeAgentId]?.adapterId);
      store.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(sessions, updated, input.now));
      const run = input.runId === undefined ? null : store.getRun(input.taskId, input.runId);
      const session = sessions.sessions[sessions.activeAgentId];
      const adapterId = run?.effective.adapterId ?? session?.adapterId;
      const driver = adapterId === undefined ? null : this.drivers.findByAdapterId(adapterId);
      const error = standardAgentError({
        source: "driver",
        phase: "turn-submit",
        classification: driver?.runtime.mapError({
          message: input.reason,
          raw: input.raw
        }),
        message: input.reason,
        raw: input.raw,
        inputDisposition: input.status === "delivery-unknown" ? "unknown" : "not-accepted"
      });
      const errorEvent = createTaskEvent(
        store.nextEventId(input.taskId),
        input.taskId,
        "runtime.agent-error",
        {
          sourceEventId: input.attemptId,
          runId: input.runId ?? "",
          roleName: input.roleName,
          agentId: run?.effective.agentId ?? sessions.activeAgentId,
          adapterId: run?.effective.adapterId ?? session?.adapterId ?? "unknown",
          driverId: driver?.id ?? "unknown",
          // No native Turn exists at submission resolution, and the Session
          // facts may be absent. An unknown fact is an absent key: an empty
          // string reads back as a real value and cannot be told apart from
          // one the Provider genuinely reported.
          ...optionalEventFields({
            nativeSessionId: session?.nativeSessionId
          }),
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
      if (input.status === "deferred" || providerRetryPending(updated)) return;
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

  private retrySubmissionResolution(
    binding: import("../runtime/providerRuntimeIdentity.js").ProviderRuntimeBinding,
    input: Readonly<{ status: string; reason: string; raw: string; attemptId: string; now: Date; noProviderWrite?: boolean }>,
    adapterId: string | undefined
  ) {
    if (input.status === "deferred") return deferProviderRetry(binding, input.now.getTime());
    const driver = adapterId === undefined ? null : this.drivers.findByAdapterId(adapterId);
    const classification = driver?.runtime.mapError({ message: input.reason, raw: input.raw });
    const error = standardAgentError({
      source: "driver", phase: "turn-submit", classification,
      message: input.reason, raw: input.raw,
      inputDisposition: input.status === "delivery-unknown" ? "unknown" : "not-accepted"
    });
    // Native preflight issued no mutation. Transient metadata failures may
    // cool down within the same deadline; unavailable proof needs an Agent.
    const noProviderWrite = input.status === "rejected" && input.noProviderWrite === true;
    if (noProviderWrite && classification?.retryable !== true) {
      const recorded = binding.run === null ? binding : {
        ...binding, run: { ...binding.run, failure: { error, ref: input.attemptId } }
      };
      return deferProviderRetry(recorded, input.now.getTime(), input.reason);
    }
    return recordProviderFailure(binding, {
      error,
      failureRef: input.attemptId, at: input.now.getTime(), noProviderWrite
    });
  }

  getProviderAuthorityFence(input: Readonly<{
    taskId: string;
    roleName: string;
    runId: string;
    agentId: string;
    nativeSessionId: string;
  }>): Readonly<{
    conversationId: string;
    epoch: number;
    owner: "controller" | "human" | "none" | "unknown";
    holderId?: string;
  }> | null {
    const sessions = this.store.getTaskRoleSessionSet(input.taskId, input.roleName);
    const session = sessions?.sessions[input.agentId];
    const binding = sessions?.providerBinding;
    if (binding === null || binding === undefined || session === undefined || session.nativeSessionId !== input.nativeSessionId || currentProviderConversation(binding).conversationId !== input.nativeSessionId) return null;
    return {
      conversationId: currentProviderConversation(binding).conversationId,
      ...binding.authority
    };
  }

  peekNextRunId(taskId: string): string {
    return this.store.peekNextRunId(taskId);
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
      if (store.getTask(taskId)?.status === "archived") return null;
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
    runId: string;
    source: import("../runtime/agentError.js").AgentErrorSource;
    phase: import("../runtime/agentError.js").AgentErrorPhase;
    message: string;
    raw: string;
    inputDisposition?: import("../runtime/agentError.js").AgentErrorInputDisposition;
    sessionDisposition?: import("../runtime/agentError.js").AgentErrorSessionDisposition;
    errorName?: string;
    causeName?: string;
    hostState?: string;
    attemptId?: string;
    registrationDisposition?:
      import("../runtime/agentError.js").AgentErrorRegistrationDisposition;
  }>, now: Date): string {
    return this.store.transaction((store) => {
      const run = store.getRun(input.taskId, input.runId);
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
      const duplicate = [...store.listEvents(input.taskId)].reverse().find((event) => (
        event.type === "runtime.agent-error"
        && event.payload.runId === input.runId
        && event.payload.roleName === input.roleName
        && event.payload.phase === input.phase
        && event.payload.attemptId === input.attemptId
        && event.payload.source === error.source
        && event.payload.inputDisposition === error.inputDisposition
        && event.payload.sessionDisposition === error.sessionDisposition
        && event.payload.registrationDisposition === input.registrationDisposition
        && event.payload.hostState === input.hostState
        && (input.attemptId === undefined
          ? event.payload.raw === error.raw
          : event.payload.message === error.message
            && event.payload.errorName === input.errorName
            && event.payload.causeName === input.causeName)
      ));
      // Re-reading one failed attempt may add a different caller stack, not a
      // new execution fact. Preserve its first full cause without multiplying
      // notifications; changed disposition/identity/diagnostic remains visible.
      if (duplicate !== undefined) return duplicate.id;
      const event = createTaskEvent(
        store.nextEventId(input.taskId),
        input.taskId,
        "runtime.agent-error",
        {
          sourceEventId: `${input.runId}:${input.phase}${input.attemptId === undefined ? "" : `:${input.attemptId}`}`,
          runId: input.runId,
          roleName: input.roleName,
          agentId: run?.effective.agentId ?? session?.agentId ?? "unknown",
          adapterId: run?.effective.adapterId ?? session?.adapterId ?? "unknown",
          driverId: driver?.id ?? "unknown",
          source: error.source,
          phase: error.phase,
          category: error.category,
          code: error.code,
          message: error.message,
          raw: error.raw,
          inputDisposition: error.inputDisposition,
          sessionDisposition: error.sessionDisposition,
          // Structured facts from the failing operation. Absent keys stay
          // absent rather than becoming an empty string, so a reader can tell
          // "the Host did not report this" from "the Host reported nothing".
          // The Session identities follow the same rule: this failure can
          // happen before any Session record exists, and there is no native
          // AgentRun to name at all.
          ...optionalEventFields({
            nativeSessionId: session?.nativeSessionId,
            errorName: input.errorName,
            causeName: input.causeName,
            hostState: input.hostState,
            attemptId: input.attemptId,
            registrationDisposition: input.registrationDisposition
          })
        },
        now
      );
      store.saveEvent(input.taskId, event);
      if (input.phase === "turn-submit" && error.inputDisposition === "unknown"
        && input.attemptId !== undefined && sessionSet?.providerBinding?.run?.attemptId === input.attemptId
        && sessionSet.providerBinding.run.status === "submitting") {
        // A pass clock can precede the asynchronous Host registration.
        const observedAt = new Date(Math.max(now.getTime(), Date.parse(sessionSet.providerBinding.run.updatedAt)));
        store.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(sessionSet,
          settleProviderTurnSubmission(sessionSet.providerBinding, { attemptId: input.attemptId,
            status: "delivery-unknown", reason: error.message, resolvedAt: observedAt.toISOString()
          }), observedAt));
      }
      if (input.errorName === "ProviderTurnBusyError" && error.inputDisposition === "not-accepted") return event.id;
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
            dedupeKey: `agent-error:${input.taskId}:${input.runId}:${input.phase}:${event.id}`
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
            dedupeKey: `leader-agent-error:${input.taskId}:${input.runId}:${event.id}`
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
   * separates scheduler backpressure from real AgentRun failures.
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

  settleRoleRunDispatch(
    input: Parameters<SchedulerStorePort["settleRoleRunDispatch"]>[0]
  ): ReturnType<SchedulerStorePort["settleRoleRunDispatch"]> {
    return this.store.transaction((store) => (
      settleRoleRunDispatchMailbox(
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
          disposition !== "replace-session" && !mailbox.processing.batch.reasons.every(isRuntimeCleanupReason)
        ) {
          return false;
        }
        mailbox = completeProcessing(mailbox, mailbox.processing.batchId);
      }
      const pending = mailbox.pending;
      if (pending !== null) {
        if (
          disposition !== "replace-session" && (pending.reasons.length === 0
          || !pending.reasons.every(isRuntimeCleanupReason))
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
      if (disposition !== "detach-host" && owner.scope === "task") {
        // Physical quiescence was proven by stopOwner. Runs are engineering
        // attempts: cancel only this Role, never Task intent or other workers.
        cancelQuiescentRoleRuns(store, owner.taskId, owner.roleName,
          "Session execution stopped on request; durable Task context and workspace progress were preserved.", now);
        let set = store.getTaskRoleSessionSet(owner.taskId, owner.roleName);
        if (set !== null) {
          // Late observations cannot resurrect engineering occupancy after
          // the exact native/process stop just completed.
          if (set.providerBinding !== null) {
            let binding = set.providerBinding;
            if (binding.run !== null) binding = cancelQuiescentProviderInput(binding, {
              attemptId: binding.run.attemptId, cancelledAt: now.toISOString(),
              reason: "Session replacement after verified resource stop."
            });
            set = updateTaskRoleProviderRuntime(set, clearProviderGoal(binding), now);
          }
          store.saveTaskRoleSessionSet(set);
        }
        endRuntimeOwnerSession(store, owner, now);
      }
      if (disposition === "replace-session" && owner.scope === "task") {
        const set = store.getTaskRoleSessionSet(owner.taskId, owner.roleName);
        if (set !== null) store.saveTaskRoleSessionSet(selectNewTaskRoleSession(set, set.activeAgentId, now));
        const event = createTaskEvent(store.nextEventId(owner.taskId), owner.taskId,
          "runtime.session-replaced", { roleName: owner.roleName }, now);
        store.saveEvent(owner.taskId, event);
        // Accepted notification batches are already consumed; unresolved old
        // claims belong to the discarded runtime, not to its successor.
        const leaderTarget = { kind: "role", taskId: owner.taskId, roleName: "leader" } as const;
        const leaderMailbox = store.getWorkMailbox(leaderTarget);
        if (owner.roleName === "leader" && leaderMailbox?.processing?.owner.startsWith("leader-notification:")) {
          store.saveWorkMailbox(releaseProcessing(leaderMailbox, leaderMailbox.processing.batchId));
        }
        enqueueWork(store, leaderTarget, "session-replaced", now, [{ type: "event", taskId: owner.taskId, id: event.id }]);
      } else if (disposition === "end-session") {
        if (owner.scope === "global") endRuntimeOwnerSession(store, owner, now);
      } else {
        detachRuntimeOwnerHost(store, owner, now);
      }
      saveRuntimeLifecycleMailbox(store, mailbox);
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
          && this.store.getActiveRun(
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
    expectedDormantCandidate?: DormantRuntimeOwnerCandidate,
    allowActiveRun = false
  ): RuntimeLifecycleTarget | null {
    return this.store.transaction((store) => {
      if (
        expectedDormantCandidate !== undefined
        && (
          !sameRuntimeOwner(owner, expectedDormantCandidate.owner)
          || !dormantRuntimeCandidateIsCurrent(store, expectedDormantCandidate, allowActiveRun)
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

  prepareMessageContinuations(taskId: string, now: Date): void {
    const roles = new Set(this.store.listMessages(taskId).flatMap((message) =>
      message.recipient?.ownerRunId !== undefined && message.continuation?.runId === undefined ? [message.recipient.roleName] : []));
    for (const roleName of roles) {
      try {
        this.store.transaction((store) => prepareMessageContinuations(store, taskId, now, roleName));
      } catch (error) {
        const reason = `preparation-failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000);
        this.store.transaction((store) => {
          for (const message of store.listMessages(taskId)) {
            if (message.recipient?.roleName === roleName && message.recipient.ownerRunId !== undefined && message.continuation?.runId === undefined
              && message.continuation?.notDeliveredReason !== reason) {
              store.updateMessage(taskId, { ...message, continuation: { notDeliveredReason: reason } });
            }
          }
        });
      }
    }
  }

  /** The first Draft conversation is an explicit planning execution. Later
   * messages use the same notification path as direct Leader collaboration. */
  prepareDraftPlanning(taskId: string, now: Date): boolean {
    return this.store.transaction((store) => {
      const task = store.getTask(taskId);
      if (task?.status !== "draft" || task.executionGate.state !== "enabled") return false;
      if (store.getActiveRun(taskId, "leader") !== null) return true;
      if (store.listRuns(taskId).some(run => run.roleName === "leader" && run.purpose === "planning")) return false;
      const sessions = store.getTaskRoleSessionSet(taskId, "leader");
      if (activeLiveRoleAgentSession(sessions) !== null) return false;
      const role = requireRole(store, taskId, "leader");
      const target = { kind: "role", taskId, roleName: "leader" } as const;
      const mailbox = store.getWorkMailbox(target);
      if (mailbox?.pending == null || mailbox.processing !== null) return false;
      const run = createRun(store.nextRunId(taskId), taskId, "leader", "new",
        createRunInput({ source: { type: "yui", channel: "task-dispatch" },
          directive: `Plan Task ${taskId} with the user. Persist requirements and decisions. Request activation explicitly; planning grants no delivery authority.`,
          deltaRefIds: [] }), now, {
          purpose: "planning", effective: resolveEffectiveLaunch({ role, purpose: "planning" })
        });
      const snapshot = freezeRunContextSnapshot(store, run, now);
      const frozen = withRunContextSnapshot(run, contextSnapshotRef(snapshot));
      store.saveRun(frozen);
      store.saveActiveRun(frozen);
      // Freeze the initial notification prefix against this planning Run.
      // Later messages remain pending; acceptance or an exact terminal settles
      // only this batch, so a failed initial launch cannot replay it forever.
      const batchId = formatRunReceiptId(taskId, run.id);
      store.saveWorkMailbox(bindExecution(claimPending(mailbox, {
        batchId, owner: `planning:${run.id}`, startedAt: now.toISOString()
      }), batchId, { type: "run", taskId, id: run.id }));
      return true;
    });
  }

  claimLeaderNotification(taskId: string, now: Date): import("../scheduler/ports.js").LeaderNotification | null {
    return this.store.transaction((store) => {
      const task = store.getTask(taskId);
      if (task == null || !["active", "draft"].includes(task.status) || task.executionGate.state !== "enabled") return null;
      const target = { kind: "role", taskId, roleName: "leader" } as const;
      let mailbox = store.getWorkMailbox(target);
      if (mailbox === null) return null;
      const provider = store.getTaskRoleSessionSet(taskId, "leader")?.providerBinding?.run;
      const processing = mailbox.processing;
      if (processing !== null) {
        if (!processing.owner.startsWith("leader-notification:")) return null;
        const wakeId = processing.owner.slice("leader-notification:".length);
        const attemptId = processing.batchId;
        const previous = store.listEvents(taskId).filter((event) =>
          event.type === "notification.delivery" && event.payload.attemptId === attemptId).at(-1);
        const native = provider?.attemptId === attemptId ? provider : undefined;
        const accepted = store.listEvents(taskId).some((event) => {
          const observation = runtimeObservationFromTaskEvent(event);
          return observation?.fence.roleName === "leader"
            && observation.fence.receiptId === attemptId
            && ((observation.kind === "turn.accepted" && observation.authority !== "transport")
              || isRunTerminalObservation(observation));
        });
        if (accepted || native?.status === "accepted" || previous?.payload.outcome === "accepted") {
          this.settleLeaderNotification(taskId, attemptId, "accepted", now);
          return null;
        }
        if (native?.status === "rejected" || previous?.payload.outcome === "rejected") {
          this.settleLeaderNotification(taskId, attemptId, "rejected", now);
          return null;
        }
        if (native?.status === "submitting") return { wakeId, attemptId, disposition: "pending" };
        if (native?.status !== "deferred" && previous?.payload.outcome !== "deferred") {
          this.settleLeaderNotification(taskId, attemptId, "unknown", now,
            "Acceptance could not be recovered. Preserve the fixed wake; no automatic replay.");
          return { wakeId, attemptId, disposition: "unknown" };
        }
        if (provider !== null && provider !== undefined && provider.attemptId !== attemptId
          && ["submitting", "accepted", "delivery-unknown"].includes(provider.status)) {
          return { wakeId, attemptId, disposition: "pending" };
        }
        const nextAttempt = `notification:${taskId}/${wakeId}/${randomUUID()}`;
        store.saveWorkMailbox({ ...mailbox, processing: { ...processing, batchId: nextAttempt } });
        return { wakeId, attemptId: nextAttempt, disposition: "submit" };
      }
      if (mailbox.pending === null || (provider !== null && provider !== undefined
        && ["submitting", "accepted", "delivery-unknown"].includes(provider.status))) return null;
      const pending = mailbox.pending;
      const pendingMessageIds = new Set(pending.refs.filter((ref) => ref.type === "message").map((ref) => ref.id));
      const claimedMessages = store.listMessages(taskId).filter((message) =>
        pendingMessageIds.has(message.id) && message.interruptThen?.targetRoleName === "leader");
      const sessions = store.getTaskRoleSessionSet(taskId, "leader");
      const session = sessions?.sessions[sessions.activeAgentId];
      const obsoleteIds = new Set<string>();
      for (const message of claimedMessages) {
        const claim = message.interruptThen!;
        if (claim.notDeliveredReason !== undefined
          || session?.nativeSessionId !== claim.targetNativeSessionId
          || session.agentId !== claim.targetAgentId
          || session.adapterId !== claim.targetAdapterId
          || (sessions?.providerBinding != null && (
            sessions.providerBinding.authority.epoch !== claim.targetAuthorityEpoch
            || sessions.providerBinding.authority.holderId !== claim.targetAuthorityHolderId))) {
          obsoleteIds.add(message.id);
          if (claim.notDeliveredReason === undefined) store.updateMessage(taskId, {
            ...message, interruptThen: { ...claim, notDeliveredReason: "target-session-or-authority-changed" }
          });
        }
      }
      const availableRefs = pending.refs.filter(ref => !(ref.type === "message" && obsoleteIds.has(ref.id)));
      const handoffs = claimedMessages.filter(message => !obsoleteIds.has(message.id));
      // A quiet/new Session is not evidence that the claimed old Turn stopped.
      // Keep the exact pending intent until the original fence is provable.
      if (handoffs.some((message) => interruptThenTerminalState(store, message) !== "ready")) return null;
      const handoffIds = new Set(handoffs.map((message) => message.id));
      if (availableRefs.length === 0 && obsoleteIds.size > 0) {
        store.saveWorkMailbox(consumePendingBatch(mailbox, pending));
        return null;
      }
      const selectedRefs = handoffs.length === 0 ? availableRefs
        : availableRefs.filter((ref) => ref.type === "message" && handoffIds.has(ref.id));
      const remainingRefs = handoffs.length === 0 ? []
        : availableRefs.filter((ref) => !(ref.type === "message" && handoffIds.has(ref.id)));
      const latest = latestTaskWake(store.listTaskWakes(taskId));
      const wakeId = store.nextTaskWakeId(taskId);
      const wake = createTaskWake({
        id: wakeId, taskId, reasons: mailbox.pending.reasons,
        refs: selectedRefs,
        fromCursor: latest?.toCursor ?? task.createdAt,
        toCursor: new Date(Math.max(now.getTime(), Date.parse(mailbox.pending.lastQueuedAt))).toISOString(), now
      });
      const attemptId = `notification:${taskId}/${wakeId}/${randomUUID()}`;
      mailbox = claimPending(mailbox, { batchId: attemptId,
        owner: `leader-notification:${wakeId}`, startedAt: now.toISOString() });
      store.saveTaskWake(taskId, wake);
      store.saveWorkMailbox(mailbox);
      // The mailbox is only a hint. Carry ordinary refs into its next pending
      // batch, rather than delivering them with the chosen immediate successor.
      if (remainingRefs.length > 0) enqueueWork(store, target, "user-message", now, remainingRefs,
        { source: "controller", dedupeKey: `then-remainder:${wakeId}` });
      return { wakeId, attemptId, disposition: "submit" };
    });
  }

  settleLeaderNotification(taskId: string, attemptId: string,
    outcome: "accepted" | "deferred" | "rejected" | "unknown", now: Date, detail?: string): void {
    this.store.transaction((store) => {
      const target = { kind: "role", taskId, roleName: "leader" } as const;
      const mailbox = store.getWorkMailbox(target);
      const processing = mailbox?.processing;
      if (mailbox == null || processing == null || processing.batchId !== attemptId
        || !processing.owner.startsWith("leader-notification:")) return;
      if (!store.listEvents(taskId).some((event) => event.type === "notification.delivery"
        && event.payload.attemptId === attemptId && event.payload.outcome === outcome)) {
        store.saveEvent(taskId, createTaskEvent(store.nextEventId(taskId), taskId,
          "notification.delivery", { attemptId, outcome, ...(detail === undefined ? {} : { detail }) }, now));
      }
      if (store.getTask(taskId)?.status === "archived") return;
      if (outcome !== "accepted" && outcome !== "rejected") return;
      store.saveWorkMailbox(completeProcessing(mailbox, attemptId));
      if (outcome === "accepted") {
        const wakeId = processing.owner.slice("leader-notification:".length);
        const wake = store.listTaskWakes(taskId).find((entry) => entry.id === wakeId);
        if (wake !== undefined) store.saveTaskWake(taskId, markTaskWakeConsumed(wake, now));
      }
    });
  }

  saveRoleRunPrepared(input: RoleRunDeliveryPersistence): void {
    this.store.transaction((store) => {
      const task = store.getTask(input.task.id);
      const role = requireRole(store, input.task.id, input.role.name);
      const active = store.getActiveRun(input.task.id, input.role.name);
      if (active === null || active.id !== input.run.id) {
        throw new Error(`Active AgentRun changed before preparation was persisted: ${input.run.id}.`);
      }
      // The Turn's own purpose decides which Task lifecycle admits it, so a
      // planning Turn on a Draft persists its Session while every other purpose
      // still requires an active Task. Read the durable active Turn, never the
      // caller's copy, so admission cannot be widened by a stale input.
      if (task === null || !runPurposeAdmitsTaskState(active.purpose, task)) {
        throw new Error(`Task is not active: ${input.task.id}.`);
      }
      if (store.getTaskRoleSessionSet(input.task.id, input.role.name) === null) {
        store.saveTaskRoleSessionSet(createRoleSessionSet(
          { scope: "task", taskId: input.task.id, roleName: input.role.name },
          input.run.effective.agentId,
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
        if (!defersConversationReplacement && (existing?.nativeSessionId !== input.session.nativeSessionId || existing.status !== "active")) {
          saveTaskSession(store, role, {
            ...input.session,
            nativeSessionId: input.session.nativeSessionId
          }, "active", input.now);
        }
        if (!defersConversationReplacement && !store.listEvents(input.task.id).some((event) =>
          event.type === "run.session-prepared" && event.payload.runId === input.run.id
          && event.payload.nativeSessionId === input.session!.nativeSessionId)) {
          store.saveEvent(input.task.id, createTaskEvent(store.nextEventId(input.task.id), input.task.id,
            "run.session-prepared", { runId: input.run.id, roleName: role.name,
              nativeSessionId: input.session.nativeSessionId }, input.now));
        }
      }
    });
  }

  saveRoleRunDeliveryFailure(
    input: RoleRunDeliveryFailurePersistence
  ): "failed" | "state-changed" {
    return this.store.transaction((store) => {
      const task = store.getTask(input.taskId);
      const role = store.getRole(input.taskId, input.roleName);
      const active = store.getActiveRun(input.taskId, input.roleName);
      const sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName);
      const session = sessions?.sessions[input.agentId];
      if (
        task === null
        || active === null
        || !runPurposeAdmitsTaskState(active.purpose, task)
        || role === null
        || active.id !== input.runId
        || active.status !== "active"
        || active.effective.agentId !== input.agentId
        || active.effective.adapterId !== input.adapterId
      ) {
        return "state-changed";
      }

      const summary = input.summary
        ?? `Role delivery failed conclusively before exact AgentRun input acceptance: ${input.runId}.`;
      const result = terminalizeExactTaskRun(store, {
        taskId: input.taskId,
        roleName: input.roleName,
        agentId: input.agentId,
        runId: input.runId,
        ...(session?.nativeSessionId === undefined
          ? {}
          : { nativeSessionId: session.nativeSessionId }),
        outcome: { status: "failed", diagnostic: summary, failureReason: input.failureReason }
      }, input.now);
      if (result.disposition !== "applied" || result.run === null) {
        return "state-changed";
      }

      const terminal = result.run;
      const deliveryFailureEvent = createTaskEvent(
        store.nextEventId(input.taskId),
        input.taskId,
        "runtime.role-delivery-failed",
        {
          runId: terminal.id,
          roleName: input.roleName,
          outcome: terminal.status
        },
        input.now
      );
      store.saveEvent(input.taskId, deliveryFailureEvent);

      routeRoleEvent(
        store,
        deliveryFailureEvent,
        input.roleName,
        terminal.purpose === "review" ? "review-failed" : "role-turn-failed",
        input.now
      );
      if (input.roleName === "leader") {
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
    nativeSessionId: string;
  }>, now = new Date()): RoleAgentSession {
    return this.store.transaction((store) => (
      recordTaskRuntimeNativeSession(store, input, now)
    ));
  }

  recordLaunchedRuntimeNativeSession(input: Readonly<{
    owner: RuntimeRoleOwner;
    agentId: string;
    adapterId: string;
    nativeSessionId: string;
    effective: EffectiveLaunchSnapshot;
  }>, assertCurrent: () => void, now = new Date()): RoleAgentSession {
    return this.store.transaction((store) => {
      assertCurrent();
      const session = input.owner.scope === "task"
        ? recordTaskRuntimeNativeSession(store, {
            taskId: input.owner.taskId,
            roleName: input.owner.roleName,
            agentId: input.agentId,
            adapterId: input.adapterId,
            nativeSessionId: input.nativeSessionId,
            effective: input.effective
          }, now)
        : recordGlobalRuntimeNativeSession(store, {
            roleName: input.owner.roleName,
            agentId: input.agentId,
            adapterId: input.adapterId,
            nativeSessionId: input.nativeSessionId,
            effective: input.effective
          }, now);
      if (input.owner.scope === "global") {
        let sessions = store.getGlobalRoleSessionSet(input.owner.roleName)!;
        let binding = sessions.providerBinding;
        if (binding == null) {
          sessions = bindGlobalRoleProviderRuntime(sessions, createProviderRuntimeBinding({
            providerNamespace: this.drivers.requireByAdapterId(input.adapterId).id,
            accountScope: input.agentId, conversationId: input.nativeSessionId,
            startedAt: now.toISOString()
          }), now);
        } else {
          if (currentProviderConversation(binding).conversationId !== input.nativeSessionId) {
            binding = supersedeProviderConversation(binding, {
              conversationId: input.nativeSessionId, switchedAt: now.toISOString(), basis: "terminal-session"
            });
          }
          if (binding.authority.owner === "none") binding = transferProviderAuthority(binding, {
            expectedEpoch: binding.authority.epoch, expectedOwner: "none",
            owner: "controller", holderId: "controller", changedAt: now.toISOString()
          });
          sessions = updateGlobalRoleProviderRuntime(sessions, binding, now);
        }
        store.saveGlobalRoleSessionSet(sessions);
      } else {
        let sessions = store.getTaskRoleSessionSet(input.owner.taskId, input.owner.roleName);
        if (sessions !== null && sessions.providerBinding === null) {
          sessions = bindTaskRoleProviderRuntime(sessions, createProviderRuntimeBinding({
            providerNamespace: this.drivers.requireByAdapterId(input.adapterId).id,
            accountScope: input.agentId, conversationId: input.nativeSessionId,
            startedAt: now.toISOString()
          }), now);
          store.saveTaskRoleSessionSet(sessions);
        } else if (sessions?.providerBinding != null
          && currentProviderConversation(sessions.providerBinding).conversationId !== input.nativeSessionId) {
          sessions = updateTaskRoleProviderRuntime(sessions, supersedeProviderConversation(sessions.providerBinding, {
            conversationId: input.nativeSessionId, switchedAt: now.toISOString(), basis: "terminal-session"
          }), now);
          store.saveTaskRoleSessionSet(sessions);
        }
        const binding = sessions?.providerBinding;
        if (sessions !== null && binding !== null && binding !== undefined
          && binding.authority.owner === "none"
          && currentProviderConversation(binding).conversationId === input.nativeSessionId) {
          store.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(
            sessions,
            transferProviderAuthority(binding, {
              expectedEpoch: binding.authority.epoch,
              expectedOwner: "none",
              owner: "controller",
              holderId: "controller",
              changedAt: now.toISOString()
            }),
            now
          ));
        }
      }
      return session;
    });
  }

  /**
   * Fast hook path: validates the native Turn boundary before it is either
   * retained as an intermediate child wait or recorded as a ready boundary
   * for later mailbox input. It never performs tmux, workspace, or Controller I/O.
   */
  classifyRuntimeRunTerminal(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId: string;
    nativeTurnId?: string;
    attemptId?: string;
    runId?: string;
    providerStatus: "completed" | "failed" | "cancelled";
    outcome: RuntimeRunTerminalOutcome;
  }>): "apply" | "deferred" | "obsolete" {
    return resolveTerminalExecution(this.store, input) === null ? "obsolete" : "apply";
  }

  observeRuntimeRunTerminal(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId: string;
    nativeTurnId?: string;
    attemptId?: string;
    runId?: string;
    input?: string;
    providerStatus: "completed" | "failed" | "cancelled";
    outcome: RuntimeRunTerminalOutcome;
    observation?: RuntimeObservation;
  }>, now = new Date()): Readonly<{
    session?: RoleAgentSession;
    duplicate: boolean;
    run?: AgentRun;
    disposition?: "obsolete";
  }> {
    // Resource inspection is bounded but external to SQLite. Revalidate the
    // immutable AgentRun workspace after acquiring the write transaction.
    const preparedRun = resolveTerminalExecution(this.store, input)?.run;
    const workspace = preparedRun?.status === "active"
      && preparedRun.executionGroupId !== undefined
      && preparedRun.executionLaneId !== undefined
      && preparedRun.workspace !== undefined
      && input.outcome.status === "completed"
      ? this.snapshotExecutionLaneWorkspace(this.store, preparedRun.workspace)
      : undefined;
    return this.store.transaction((store) => {
      const task = store.getTask(input.taskId);
      if (task === null) throw new Error(`Task not found: ${input.taskId}.`);
      if (task.status === "archived") {
        throw new Error(`Cannot complete a runtime run for unavailable Task: ${input.taskId}.`);
      }
      const resolved = resolveTerminalExecution(store, input);
      if (resolved === null) throw new Error("Runtime terminal has no exact execution binding.");
      const { run: observedRun, current: recordedProviderTurn, attemptId } = resolved;
      if (!isDeepStrictEqual(preparedRun?.workspace, observedRun?.workspace)) {
        throw new Error("Runtime terminal workspace changed during result preparation.");
      }
      if (workspace !== undefined && observedRun?.workspace !== undefined
        && !isDeepStrictEqual(store.getManagedWorkspace(observedRun.workspace.owner), observedRun.workspace)) {
        throw new Error("Runtime terminal workspace ownership changed during result preparation.");
      }
      let sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName)
        ?? createRoleSessionSet(
          { scope: "task", taskId: input.taskId, roleName: input.roleName },
          input.agentId,
          now
        );
      const canonicalRunId = input.nativeTurnId ?? resolved.nativeTurnId;
      assertConsistentTerminal(store, input, observedRun);
      // A historical operation failure stays failed. The immutable terminal
      // observation retains the late report for explicit Leader adoption.
      // Never touch a successor Session, active pointer, mailbox or Review.
      if (!recordedProviderTurn || (observedRun !== null && observedRun.status !== "active")) {
        // A failed operation and a subsequently confirmed Provider outcome are
        // distinct facts. Settle only the still-owned original attempt, never
        // rewriting the historical Task result or a successor's binding.
        if (recordedProviderTurn && sessions.providerBinding?.run !== null
          && sessions.providerBinding?.run !== undefined
          && ["submitting", "accepted", "delivery-unknown"].includes(
            sessions.providerBinding.run.status
          )) {
          if (sessions.providerBinding.run.status !== "accepted") {
            sessions = updateTaskRoleProviderRuntime(sessions, acceptProviderTurn(sessions.providerBinding, {
              attemptId,
              ...(canonicalRunId === undefined ? {} : { nativeTurnId: canonicalRunId }),
              acceptedAt: now.toISOString()
            }), now);
          }
          sessions = settleStructuredProviderTurn(sessions, canonicalRunId, input.providerStatus, now, attemptId);
          store.saveTaskRoleSessionSet(sessions);
        }
        if (input.observation !== undefined) this.persistRuntimeObservation(input.observation, now);
        return {
          ...(sessions.sessions[input.agentId] === undefined
            ? {} : { session: sessions.sessions[input.agentId] }),
          duplicate: true,
          ...(observedRun === null ? {} : { run: observedRun })
        };
      }
      const pending = sessions.providerBinding!;
      if (pending.run?.status === "submitting" || pending.run?.status === "delivery-unknown") {
        sessions = updateTaskRoleProviderRuntime(sessions, acceptProviderTurn(pending, {
          attemptId,
          ...(canonicalRunId === undefined ? {} : { nativeTurnId: canonicalRunId }),
          acceptedAt: now.toISOString()
        }), now);
      }
      sessions = settleStructuredProviderTurn(
        sessions,
        canonicalRunId,
        input.providerStatus,
        now,
        attemptId
      );
      if (canonicalRunId !== undefined) sessions = recordTaskRoleNativeTurnBoundary(sessions, {
        agentId: input.agentId,
        nativeSessionId: input.nativeSessionId,
        turnId: canonicalRunId
      }, now);
      if (input.observation?.payload.failure?.error.sessionDisposition === "unrecoverable"
        && sessions.providerBinding !== null) {
        sessions = updateTaskRoleProviderRuntime(sessions,
          updateProviderConversationRecoverability(sessions.providerBinding, "unrecoverable"), now);
      }
      if (input.observation?.kind === "turn.failed" && input.observation.payload.failure !== undefined
        && sessions.providerBinding !== null) {
        sessions = updateTaskRoleProviderRuntime(sessions, recordProviderFailure(sessions.providerBinding, {
          error: input.observation.payload.failure.error, failureRef: input.observation.eventId, at: now.getTime()
        }), now);
      }
      store.saveTaskRoleSessionSet(sessions);
      let terminalRun: AgentRun | undefined;
      if (recordedProviderTurn && observedRun?.status === "active") {
        const binding = sessions.providerBinding!;
        const conversation = binding.conversations.find((entry) => entry.conversationId === input.nativeSessionId)!;
        const providerStatus = input.providerStatus;
        let systemEvidence: Parameters<typeof terminalizeExactTaskRun>[1]["systemEvidence"];
        let workspaceFailure: Parameters<typeof terminalizeExactTaskRun>[1]["workspaceFailure"];
        if ((observedRun.purpose === "execution" || observedRun.purpose === "review")
          && observedRun.executionGroupId !== undefined
          && observedRun.executionLaneId !== undefined
          && observedRun.workspace !== undefined
          && input.outcome.status === "completed") {
          const gitSnapshot = workspace!;
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
        const terminalized = terminalizeExactTaskRun(store, {
          taskId: input.taskId,
          roleName: input.roleName,
          agentId: input.agentId,
          runId: observedRun.id,
          nativeSessionId: input.nativeSessionId,
          outcome: {
            ...input.outcome,
            provider: {
              providerNamespace: binding.providerNamespace,
              accountScope: binding.accountScope,
              conversationId: conversation.conversationId,
              ...(canonicalRunId === undefined ? {} : { nativeTurnId: canonicalRunId }),
              attemptId,
              status: providerStatus
            }
          },
          ...(systemEvidence === undefined ? {} : { systemEvidence }),
          ...(workspaceFailure === undefined ? {} : { workspaceFailure })
        }, now);
        if (terminalized.disposition !== "applied" || terminalized.run === null) {
          throw new Error(
            `Provider AgentRun terminal could not complete its exact AgentRun: ${
              terminalized.reason ?? "obsolete"
            }.`
          );
        }
        terminalRun = terminalized.run;
        const event = createTaskEvent(
          store.nextEventId(input.taskId),
          input.taskId,
          terminalRun.status === "completed" ? "run.completed" : "run.failed",
          {
            runId: terminalRun.id,
            roleName: terminalRun.roleName,
            ...(canonicalRunId === undefined ? {} : { providerTurnId: canonicalRunId }),
            providerStatus
          },
          now
        );
        store.saveEvent(input.taskId, event);
        // A structured failure routes its original runtime.agent-error below;
        // the AgentRun terminal is the same fact, not a second notification.
        const structuredFailure = input.observation?.kind === "turn.failed"
          && input.observation.payload.failure !== undefined;
        if (!structuredFailure && terminalRun.roleName === "leader"
          && terminalRun.status === "failed") {
          routeRoleEvent(
            store,
            event,
            terminalRun.roleName,
            terminalRun.purpose === "review" ? "review-result" : "role-turn-result",
            now
          );
        }
      }
      if (input.observation !== undefined) this.persistRuntimeObservation(input.observation, now);
      return {
        session: sessions.sessions[input.agentId]!,
        duplicate: false,
        ...(terminalRun === undefined ? {} : { run: terminalRun })
      };
    });
  }

  saveRoleHostExitObservation(input: Readonly<{
    taskId: string;
    roleName: string;
    runId: string;
    nativeSessionId?: string;
    deadStatus?: number;
    observedAt: Date;
  }>): void {
    this.store.transaction((store) => {
      const identity = [
        input.taskId,
        input.roleName,
        input.runId,
        String(input.deadStatus ?? "unknown-status")
      ].join("\0");
      const observationId = `tmux-host-exit-${createHash("sha256").update(identity).digest("hex")}`;
      const events = store.listEvents(input.taskId);
      if (events.some((event) => (
        event.type === "runtime.process-exit-observed"
        && event.payload.observationId === observationId
      ))) return;
      const observation = validateRuntimeProcessExitObservation({
        schemaVersion: 2,
        observationId,
        hostSequence: 1,
        hostInstanceId: `tmux-${input.roleName}`,
        taskId: input.taskId,
        roleName: input.roleName,
        runId: input.runId,
        ...(input.nativeSessionId === undefined
          ? {}
          : { nativeSessionId: input.nativeSessionId }),
        processKind: "agent-host",
        ...(input.deadStatus === undefined ? {} : { exitCode: input.deadStatus }),
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
          observedAt: observation.observedAt,
          classification,
          observation: JSON.stringify(observation)
        },
        input.observedAt
      ));
    });
  }

  /**
   * Issue 04: reopens each due retry on its original Native Session. A AgentRun
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
            const run = store.getRun(taskId, input.fence.runId!);
            if (role === null || sessions === null || run === null) {
              recordCanonicalObservationObsolete(store, input, "bind-state-missing", now);
              return "obsolete";
            }
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
          }
          const current = store.getTaskRoleSessionSet(
            input.fence.taskId!,
            input.fence.roleName
          );
          const currentSession = current?.sessions[input.fence.agentId];
          if (current !== null && current !== undefined
            && currentSession?.nativeSessionId === input.fence.nativeSessionId) {
            const run = input.fence.runId === undefined
              ? null
              : store.getRun(input.fence.taskId!, input.fence.runId);
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
      // A pipe write is retained as transport evidence, but cannot acknowledge
      // the business input. A later native receipt/terminal proves acceptance.
      if (input.authority === "transport") return "applied";
      const continuation = input.fence.receiptId?.startsWith("turn-input:") === true;
      const ordinaryAttemptId = input.fence.receiptId;
      if (!continuation && input.fence.runId !== undefined) {
        const exact = resolveTerminalExecution(store, {
          taskId: input.fence.taskId!,
          roleName: input.fence.roleName,
          agentId: input.fence.agentId,
          adapterId,
          conversationId: input.fence.conversationId,
          nativeSessionId: input.fence.nativeSessionId!,
          nativeTurnId: input.fence.nativeTurnId,
          attemptId: ordinaryAttemptId,
          runId: input.fence.runId
        });
        if (exact === null) return "obsolete";
        // A terminal can prove acceptance before the delayed receipt. Retain
        // the receipt without recreating lifecycle state or touching a successor.
        if (!exact.current || exact.run?.status !== "active") return "applied";
      }
      if (input.fence.runId === undefined
        && ordinaryAttemptId?.startsWith("direct:") === true) {
        const taskId = input.fence.taskId!;
        const sessions = store.getTaskRoleSessionSet(taskId, input.fence.roleName);
        const session = sessions?.sessions[input.fence.agentId];
        const binding = sessions?.providerBinding;
        const nativeTurnId = input.fence.nativeTurnId!;
        if (sessions === null || sessions === undefined || binding === null || binding === undefined || session === undefined || session.nativeSessionId !== input.fence.nativeSessionId || currentProviderConversation(binding).conversationId !== input.fence.nativeSessionId) {
          recordCanonicalObservationObsolete(store, input, "direct-turn-session-mismatch", now);
          return "obsolete";
        }
        if (binding.run?.attemptId === ordinaryAttemptId
          && binding.run.nativeTurnId === nativeTurnId) {
          return "applied";
        }
        // Native conversation is not an implicit managed assignment. Keep its
        // observation without borrowing or overwriting another request's
        // accepted, unknown, or waiting admission evidence.
        if (binding.run !== null
          && (["submitting", "accepted", "delivery-unknown"].includes(binding.run.status)
            || (binding.run.runId !== undefined
              && store.getRun(taskId, binding.run.runId)?.status === "active"))) return "applied";
        const submittedAt = input.observedAt ?? input.receivedAt;
        const accepted = acceptProviderTurn(beginProviderTurn(binding, {
          attemptId: ordinaryAttemptId,
          authorityEpoch: binding.authority.epoch,
          submittedAt
        }), {
          attemptId: ordinaryAttemptId,
          nativeTurnId,
          acceptedAt: submittedAt
        });
        store.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(sessions, accepted, now));
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
          && binding.run?.runId === undefined
          && binding.run?.attemptId === ordinaryAttemptId) {
          if (session === undefined || session.nativeSessionId !== input.fence.nativeSessionId) {
            recordCanonicalObservationObsolete(store, input, "ordinary-turn-session-mismatch", now);
            return "obsolete";
          }
          store.saveTaskRoleSessionSet(recordStructuredProviderAcceptance(
            sessions,
            input,
            now
          ));
          const retry = binding.retry;
          if (retry?.currentAttemptId === ordinaryAttemptId && retry.input.kind === "wake") {
            const originalWakeId = retry.input.wakeId;
            const original = store.listTaskWakes(input.fence.taskId!).find(w => w.id === originalWakeId);
            if (original !== undefined && original.status !== "consumed") {
              store.saveTaskWake(input.fence.taskId!, markTaskWakeConsumed(original, now));
            }
          }
          return "applied";
        }
      }
      if (continuation) {
        const active = store.getActiveRun(input.fence.taskId!, input.fence.roleName);
        const sessions = store.getTaskRoleSessionSet(
          input.fence.taskId!,
          input.fence.roleName
        );
        const session = sessions?.sessions[input.fence.agentId];
        if (active === null || active.id !== input.fence.runId || active.status !== "active" || sessions === null || sessions === undefined || session === undefined || session.nativeSessionId !== input.fence.nativeSessionId) {
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
          "run.input-delivered",
          {
            attemptId: input.fence.receiptId!,
            runId: active.id,
            conversationId: input.fence.conversationId ?? input.fence.nativeSessionId!,
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
      const active = store.getActiveRun(input.fence.taskId!, input.fence.roleName);
      if (active === null
        || active.id !== input.fence.runId
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

  /** Reads durable AgentRun + Session state into the pure fold's expectation shape. */
  private projectRunExpectation(
    store: TaskStore,
    fence: CanonicalIdentityFence,
    runId: string | undefined
  ): CanonicalRunExpectation | null {
    const role = store.getRole(fence.taskId, fence.roleName);
    if (role === null) return null;
    const sessionSet = store.getTaskRoleSessionSet(fence.taskId, fence.roleName);
    const session = sessionSet?.sessions[fence.agentId] ?? null;
    if (runId === undefined) {
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
    const run = store.getRun(fence.taskId, runId);
    if (run === null || run.status !== "active") return null;
    const freshConversationLaunch = run.mode === "new" && session?.status !== "active";
    const boundNativeSessionId = freshConversationLaunch
      ? undefined
      : session?.nativeSessionId;
    const providerTurn = sessionSet?.providerBinding?.run;
    const managedRunMatches = managedProviderTurnId(providerTurn) === run.id;
    const expectedFence: CanonicalIdentityFence = {
      taskId: fence.taskId,
      roleName: fence.roleName,
      agentId: run.effective.agentId,
      adapterId: run.effective.adapterId,
      runId: run.id,
      receiptId: managedRunMatches && providerTurn !== null && providerTurn !== undefined
        ? providerTurn.attemptId
        : formatRunReceiptId(run.taskId, run.id),
      ...(boundNativeSessionId === undefined ? {} : { nativeSessionId: boundNativeSessionId })
    };
    const driverId = this.drivers.requireByAdapterId(run.effective.adapterId).id;
    const lifecycleEvents = store.listEvents(fence.taskId).flatMap((event) => {
      const observation = runtimeObservationFromTaskEvent(event);
      return observation !== null && (observation.kind === "session.started" || observation.kind === "session.ready") && observation.fence.roleName === fence.roleName && observation.fence.agentId === run.effective.agentId && observation.fence.driverId === driverId && observation.fence.nativeSessionId === (boundNativeSessionId ?? fence.nativeSessionId)
        ? [observation]
        : [];
    });
    return {
      fence: expectedFence,
      sessionStarted: lifecycleEvents.length > 0,
      ready: lifecycleEvents.some((event) => event.kind === "session.ready"),
      pushed: managedRunMatches,
      accepted: managedRunMatches && providerTurn !== null && providerTurn !== undefined
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
    runId?: string;
    nativeSessionId: string;
    reason: string;
    originalEvent?: RuntimeLifecycleEvent | RuntimeObservation;
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
    nativeSessionId: string;
  }>, now = new Date()): RoleAgentSession {
    return this.store.transaction((store) => (
      recordGlobalRuntimeNativeSession(store, input, now)
    ));
  }

  observeGlobalRuntimeRunTerminal(input: Readonly<{
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId: string;
    nativeTurnId: string;
    title?: string;
    providerStatus: "completed" | "failed" | "cancelled";
    outcome: RuntimeRunTerminalOutcome;
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
        existing === undefined && !runtimeHookMatchesLaunchIntent(store, owner)
      ) {
        throw new Error(
          "Runtime turn completion has no matching global Session intent."
        );
      }
      const nativeSessionId = input.nativeSessionId;
      const effectiveExisting = nativeTransitionExisting(
        store,
        owner,
        existing,
        nativeSessionId,
        "Runtime turn completion conflicts with the fixed global Role session."
      );
      const effective = globalSessionEffective(role, effectiveExisting);
      if (effective.agentId !== input.agentId || effective.adapterId !== input.adapterId) {
        throw new Error("Runtime turn completion does not match the effective global runtime identity.");
      }
      const completedStatus = effectiveExisting?.status ?? "active";
      current = recordRoleAgentSession(current, {
        agentId: input.agentId,
        adapterId: input.adapterId,
        nativeSessionId,
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
      // decision-3 §9: when a controller-owned native Turn is actually bound for
      // this Global Role, settle it to the observed terminal so the scope-generic
      // resolver and the interrupt-then gate see the real stop on the live binding
      // — the same edge Task settles via settleStructuredProviderTurn. This is a
      // strict guarded no-op for an older unmanaged Session or a
      // binding holding a different/already-terminal Turn, and the
      // durable native terminal recorded just above remains the proof of record.
      current = settleGlobalRoleRuntimeTurn(current, input.nativeTurnId, input.providerStatus, now);
      store.saveGlobalRoleSessionSet(current);
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

  classifyGlobalRuntimeRunTerminal(input: Readonly<{
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId: string;
    providerStatus: "completed" | "failed" | "cancelled";
    outcome: RuntimeRunTerminalOutcome;
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
      existing === undefined && !runtimeHookMatchesLaunchIntent(this.store, owner)
    ) return "obsolete";
    const nativeSessionId = input.nativeSessionId;
    let effectiveExisting: RoleAgentSession | undefined;
    try {
      effectiveExisting = nativeTransitionExisting(
        this.store,
        owner,
        existing,
        nativeSessionId,
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
    ...(input.fence.runId === undefined ? {} : { runId: input.fence.runId }),
    ...(input.fence.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: input.fence.nativeSessionId }),
    ...(input.fence.receiptId === undefined ? {} : { receiptId: input.fence.receiptId })
  };
}

/**
 * A live parent AgentRun still owns its native child result. Only after that AgentRun
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
  const parentRun = observation.fence.runId === undefined
    ? null
    : store.getRun(taskId, observation.fence.runId);
  if (parentRun?.status === "active") return;
  if (store.getRole(taskId, observation.fence.roleName) === null) return;
  routeRoleEvent(
    store,
    event,
    observation.fence.roleName,
    reason,
    now
  );
}

/** Accepts the original AgentRun receipt or a later mailbox activation receipt. */
function runtimeReceiptBelongsToRun(
  store: TaskStore,
  input: RuntimeObservation
): boolean {
  const taskId = input.fence.taskId!;
  const runId = input.fence.runId!;
  const receiptId = input.fence.receiptId;
  if (receiptId === formatRunReceiptId(taskId, runId)) return true;
  if (receiptId === undefined) return false;
  const sessions = store.getTaskRoleSessionSet(taskId, input.fence.roleName);
  const current = sessions?.providerBinding?.run;
  if (current?.runId === runId && current.attemptId === receiptId
    && current.status !== "rejected" && current.status !== "deferred"
    && sessions?.sessions[input.fence.agentId]?.nativeSessionId === input.fence.nativeSessionId) {
    return true;
  }
  return store.listEvents(taskId).some((event) => {
    const accepted = runtimeObservationFromTaskEvent(event);
    return accepted?.kind === "turn.accepted" && accepted.fence.runId === runId && accepted.fence.roleName === input.fence.roleName && accepted.fence.agentId === input.fence.agentId && accepted.fence.nativeSessionId === input.fence.nativeSessionId && accepted.fence.receiptId === receiptId;
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
    ...(input.fence.nativeSessionId === undefined ? {} : { nativeSessionId: input.fence.nativeSessionId }),
    ...(reason === "task-archived" ? { originalEvent: input } : {})
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
    nativeSessionId?: string;
    originalEvent?: RuntimeLifecycleEvent | RuntimeObservation;
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
      ...(input.nativeSessionId === undefined ? {} : { nativeSessionId: input.nativeSessionId }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      reason,
      ...(input.originalEvent === undefined ? {} : { originalEvent: JSON.stringify(input.originalEvent) })
    },
    now
  ));
}

function sessionPreview(value: string): string {
  const normalized = value.trim().replaceAll(/\s+/g, " ");
  const truncated = normalized.slice(0, 1_024);
  return /[\uD800-\uDBFF]$/.test(truncated)
    ? truncated.slice(0, -1)
    : truncated;
}

function runtimeHookMatchesLaunchIntent(
  store: TaskStore,
  owner: RuntimeRoleOwner
): boolean {
  const mailbox = store.getWorkMailbox(runtimeLifecycleTarget(owner));
  if (hasRuntimeCleanupObligation(mailbox)) return false;
  if (owner.scope === "global") return true;
  return store.getActiveRun(owner.taskId, owner.roleName)?.mode === "new";
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
  const run = store.getActiveRun(taskId, observation.fence.roleName);
  const sessions = store.getTaskRoleSessionSet(taskId, observation.fence.roleName);
  if (task == null || run == null || !runPurposeAdmitsTaskState(run.purpose, task)
    || role?.activeAgentId !== observation.fence.agentId
    || run?.id !== runId
    || run.status !== "active"
    || run.effective.agentId !== observation.fence.agentId
    || run.effective.adapterId !== driver.adapterId
    || observation.fence.receiptId !== formatRunReceiptId(run.taskId, run.id)
    || sessions?.sessions[observation.fence.agentId] !== undefined) return false;

  const mailbox = store.getWorkMailbox(runtimeLifecycleTarget({
    scope: "task",
    taskId,
    roleName: observation.fence.roleName
  }));
  return !hasRuntimeCleanupObligation(mailbox);
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
  candidate: DormantRuntimeOwnerCandidate,
  allowActiveRun = false
): boolean {
  const { owner } = candidate;
  if (
    !allowActiveRun && owner.scope === "task"
    && store.getActiveRun(owner.taskId, owner.roleName) !== null
  ) {
    return false;
  }
  const sessions = runtimeOwnerSessionSet(store, owner);
  const active = allowActiveRun && owner.scope === "task"
    ? taskRoleControlTarget(store.getTaskRoleSessionSet(owner.taskId, owner.roleName))
    : sessions?.sessions[sessions.activeAgentId];
  return active !== undefined && active.agentId === candidate.agentId && active.adapterId === candidate.adapterId
    && active.nativeSessionId === candidate.nativeSessionId && (allowActiveRun || active.updatedAt === candidate.sessionUpdatedAt);
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

function recordTaskRuntimeNativeSession(
  store: TaskStore,
  input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
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
  // A Draft registers a Session only for its planning Turn. Admission is decided
  // by the active Turn's purpose through the one shared invariant, so a Draft
  // still cannot open an execution Session before activation.
  const admittingRun = store.getActiveRun(input.taskId, input.roleName);
  const existingPlanning = activeLiveRoleAgentSession(store.getTaskRoleSessionSet(input.taskId, input.roleName));
  if (!(admittingRun !== null
    && admittingRun.purpose === "planning"
    && runPurposeAdmitsTaskState(admittingRun.purpose, task))
    && !(task.status === "draft" && task.executionGate.state === "enabled" && input.roleName === "leader"
      && existingPlanning?.effective.executionAuthority === "planning"
      && existingPlanning.nativeSessionId === input.nativeSessionId)
    && (task.status !== "active" || task.executionGate.state !== "enabled")) {
    throw new Error(
      `Cannot register a native session for a Task that is not active: ${input.taskId}.`
    );
  }
  const role = requireRole(store, input.taskId, input.roleName);
  if (role.activeAgentId !== input.agentId
    || activeRoleAgentBinding(role).adapterId !== input.adapterId) {
    throw new Error("Native Session registration does not match the active Role Agent.");
  }
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
    "Native session registration conflicts with the fixed Role session."
  );
  if (existing?.status === "active") return existing;
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
  if (!roleSessionMayContinue(
    resolvedEffective,
    effective
  )) {
    throw new Error("Native Session effective launch changed before persistence.");
  }
  if (effective.agentId !== input.agentId || effective.adapterId !== input.adapterId) {
    throw new Error("Native session registration does not match the effective runtime identity.");
  }
  const updated = recordRoleAgentSession(current, {
    agentId: input.agentId,
    adapterId: input.adapterId,
    nativeSessionId: input.nativeSessionId,
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
    nativeSessionId: string;
    effective?: EffectiveLaunchSnapshot;
  }>,
  now: Date
): RoleAgentSession {
  const role = store.getGlobalRole(input.roleName);
  if (role === null) throw new Error(`Global Role not found: ${input.roleName}.`);
  if (role.activeAgentId !== input.agentId
    || role.agentBindings[role.activeAgentId]?.adapterId !== input.adapterId) {
    throw new Error("Native Session registration does not match the active global Role Agent.");
  }
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
    "Native session registration conflicts with the fixed global Role session."
  );
  if (existing?.status === "active") return existing;
  const resolvedEffective = globalSessionEffective(role, effectiveExisting);
  const effective = input.effective === undefined
    ? resolvedEffective
    : validateEffectiveLaunchSnapshot(input.effective);
  if (!roleSessionMayContinue(resolvedEffective, effective)) {
    throw new Error("Global native Session effective launch changed before persistence.");
  }
  if (effective.agentId !== input.agentId || effective.adapterId !== input.adapterId) {
    throw new Error("Native session registration does not match the effective global runtime identity.");
  }
  const updated = recordRoleAgentSession(current, {
    agentId: input.agentId,
    adapterId: input.adapterId,
    nativeSessionId: input.nativeSessionId,
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
  conflictMessage: string
): RoleAgentSession | undefined {
  if (existing === undefined || existing.nativeSessionId === nativeSessionId) {
    return existing;
  }
  if (
    existing.status === "ended" && runtimeHookMatchesLaunchIntent(store, owner)
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
  const purpose = store.getTask(role.taskId)?.status === "draft" ? "planning" as const : "execution" as const;
  const item = store.listWorkItems(role.taskId).find((candidate) => (
    candidate.assignee === role.name
      && !["accepted", "retired"].includes(candidate.status)
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
  // This projection plans future dispatch. A live Session retains its actual
  // source, but cannot silently override an explicit next-Agent selection.
  // Active AgentRun delivery separately and exclusively uses turn.effective.
  const effective = reopened || (liveSession !== null && liveSession.agentId !== role.activeAgentId)
    ? resolveEffectiveLaunch({
        role,
        purpose,
        ...(workspace === undefined ? {} : { workspace })
      })
    : liveSession !== null && workspace?.owner.type === "task"
      ? effectiveLaunchWithTaskMainWorkspace(liveSession.effective, workspace)
      : liveSession?.effective ?? resolveEffectiveLaunch({
          role,
          purpose,
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
  const active = store.getActiveRun(taskId, roleName);
  if (active !== null) {
    if (active.effective.agentId !== agentId) {
      throw new Error(
        `Native Session registration does not match the effective AgentRun Agent: ${taskId}/${roleName}.`
      );
    }
    if (existing !== undefined) {
      if (!roleSessionMayContinue(
        existing.effective,
        active.effective
      )) {
        throw new Error(
          `Native Session effective launch does not match the active AgentRun: ${taskId}/${roleName}.`
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
      && !["accepted", "retired"].includes(candidate.status)
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
  now: Date
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
  expected: RoleRunStallPersistence["session"]
): boolean {
  if (current === null || expected === null) return current === expected;
  return current.agentId === expected.agentId && current.adapterId === expected.adapterId && current.nativeSessionId === expected.nativeSessionId && current.status === expected.status;
}

function requireRole(store: TaskStore, taskId: string, roleName: string) {
  const role = store.getRole(taskId, roleName);
  if (role === null) throw new Error(`Role not found: ${taskId}/${roleName}.`);
  return role;
}


/**
 * Keeps only the fields the caller actually knew. Event payloads are a
 * string map, so an unknown fact has to be an absent key: writing `""` would
 * claim the Host reported an empty value.
 */
function optionalEventFields(
  fields: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fields).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1].trim().length > 0
    )
  );
}

function runtimeObservationTelemetryEntry(
  input: RuntimeObservation
): TelemetryProgressEntry {
  return {
    taskId: input.fence.taskId!,
    roleName: input.fence.roleName,
    runId: input.fence.runId!,
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
  const runId = input.fence.nativeTurnId;
  if (current === null || attemptId === undefined) return sessions;
  if (current.run === null
    || current.run.runId !== input.fence.runId) return sessions;
  if (current.run.attemptId === attemptId
    && ["accepted", "completed", "failed", "cancelled"].includes(
      current.run.status
    )) return sessions;
  const binding = acceptProviderTurn(current, {
    attemptId,
    nativeTurnId: runId,
    acceptedAt: input.observedAt ?? input.receivedAt
  });
  return updateTaskRoleProviderRuntime(sessions, binding, now);
}

type TerminalExecutionInput = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: string;
  conversationId?: string;
  nativeSessionId: string;
  nativeTurnId?: string;
  attemptId?: string;
  runId?: string;
}>;

/** One correlation boundary shared by classification and the committing fold. */
function resolveTerminalExecution(store: TaskStore, input: TerminalExecutionInput): Readonly<{
  run: AgentRun | null;
  current: boolean;
  attemptId: string;
  nativeTurnId?: string;
}> | null {
  const task = store.getTask(input.taskId);
  if (task === null || task.status === "archived") return null;
  if (input.conversationId !== undefined && input.conversationId !== input.nativeSessionId) return null;
  const sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName);
  const session = sessions?.sessions[input.agentId];
  const binding = sessions?.providerBinding;
  const pending = binding?.run;
  const evidence = store.listEvents(input.taskId).map(runtimeObservationFromTaskEvent)
    .filter((event): event is RuntimeObservation => event !== null
      && (event.kind === "turn.accepted" || isRunTerminalObservation(event)));
  if (input.attemptId !== undefined && evidence.some((event) => (
    event.fence.roleName === input.roleName
    && event.fence.agentId === input.agentId
    && event.fence.nativeSessionId === input.nativeSessionId
    && event.fence.receiptId === input.attemptId
    && input.nativeTurnId !== undefined && event.fence.nativeTurnId !== undefined
    && event.fence.nativeTurnId !== input.nativeTurnId
  ))) return null;
  const identityMatches = (attemptId: string | undefined, nativeTurnId: string | undefined) => (
    (input.attemptId === undefined
      ? input.nativeTurnId !== undefined && input.nativeTurnId === nativeTurnId
      : input.attemptId === attemptId)
    && !(input.nativeTurnId !== undefined && nativeTurnId !== undefined
      && input.nativeTurnId !== nativeTurnId)
  );
  if (binding !== null && binding !== undefined && pending !== null && pending !== undefined
    && session?.adapterId === input.adapterId
    && session.nativeSessionId === input.nativeSessionId
    && currentProviderConversation(binding).conversationId === input.nativeSessionId
    && identityMatches(pending.attemptId, pending.nativeTurnId)
    && (input.runId === undefined || input.runId === pending.runId)
    && pending.status !== "rejected" && pending.status !== "deferred") {
    const run = pending.runId === undefined ? null : store.getRun(input.taskId, pending.runId);
    if (pending.runId === undefined || (
      run !== null && run.roleName === input.roleName
      && run.effective.agentId === input.agentId && run.effective.adapterId === input.adapterId
    )) return {
      run, current: true, attemptId: pending.attemptId,
      nativeTurnId: pending.nativeTurnId,
    };
  }
  // Old results use immutable acceptance/terminal evidence, not today's Role
  // config, Session status or active AgentRun pointer.
  const matches = evidence.filter((event) => event.fence.roleName === input.roleName
      && event.fence.agentId === input.agentId
      && event.fence.nativeSessionId === input.nativeSessionId
      && identityMatches(event.fence.receiptId, event.fence.nativeTurnId)
      && (input.runId === undefined || event.fence.runId === input.runId));
  const accepted = matches[0];
  if (accepted === undefined || accepted.fence.receiptId === undefined) return null;
  if (matches.some((event) => event.fence.runId !== accepted.fence.runId
    || event.fence.receiptId !== accepted.fence.receiptId)) {
    throw new Error("Runtime terminal has conflicting durable execution bindings.");
  }
  if (accepted.fence.runId === undefined) {
    return { run: null, current: false, attemptId: accepted.fence.receiptId,
      nativeTurnId: accepted.fence.nativeTurnId };
  }
  const run = store.getRun(input.taskId, accepted.fence.runId);
  if (run === null || run.effective.adapterId !== input.adapterId
    || run.effective.agentId !== input.agentId || run.roleName !== input.roleName) return null;
  return {
    run, current: false, attemptId: accepted.fence.receiptId,
    nativeTurnId: accepted.fence.nativeTurnId,
  };
}

function isRunTerminalObservation(input: RuntimeObservation): boolean {
  return ["turn.completed", "turn.failed", "turn.cancelled"].includes(input.kind);
}

function assertConsistentTerminal(
  store: TaskStore,
  input: TerminalExecutionInput & Readonly<{
    providerStatus: "completed" | "failed" | "cancelled";
    outcome: RuntimeRunTerminalOutcome;
    observation?: RuntimeObservation;
  }>,
  run: AgentRun | null
): void {
  const previous = store.listEvents(input.taskId).map(runtimeObservationFromTaskEvent)
    .filter((event): event is RuntimeObservation => event !== null
      && isRunTerminalObservation(event)
      && event.fence.roleName === input.roleName
      && event.fence.agentId === input.agentId
      && event.fence.nativeSessionId === input.nativeSessionId
      && (input.attemptId === undefined
        ? input.nativeTurnId !== undefined && event.fence.nativeTurnId === input.nativeTurnId
        : event.fence.receiptId === input.attemptId));
  if (input.observation !== undefined && previous.some((event) => (
    event.kind !== input.observation!.kind
    || !isDeepStrictEqual(event.payload, input.observation!.payload)
    || event.fence.runId !== input.observation!.fence.runId
  ))) throw new Error("Conflicting terminal content for the same execution.");
  if (run?.result?.provider !== undefined) {
    if (run.result.provider.status !== input.providerStatus
      || (input.outcome.status === "completed" && run.result.output !== input.outcome.output)
      || (previous.length === 0 && input.outcome.status === "failed"
        && run.result.diagnostic !== input.outcome.diagnostic)) {
      throw new Error("Conflicting result for the same execution.");
    }
  }
}

function terminalSessionReplacementBasis(
  sessions: TaskRoleSessionSet,
  input: RuntimeObservation,
  run: AgentRun
): "terminal-session" | undefined {
  const binding = sessions.providerBinding;
  const session = sessions.sessions[input.fence.agentId];
  const incomingConversationId = input.fence.conversationId ?? input.fence.nativeSessionId;
  if (run.mode !== "new"
    || binding === null
    || session === undefined
    || incomingConversationId === undefined
    || currentProviderConversation(binding).conversationId === incomingConversationId
    || session.status !== "ended") {
    return undefined;
  }
  return "terminal-session";
}

function bindOrSupersedeProviderRuntime(
  sessions: TaskRoleSessionSet,
  input: RuntimeObservation,
  now: Date,
  replacementBasis?: "terminal-session"
): TaskRoleSessionSet {
  const conversationId = input.fence.conversationId ?? input.fence.nativeSessionId!;
  if (sessions.providerBinding === null) {
    return bindTaskRoleProviderRuntime(sessions, createProviderRuntimeBinding({
      providerNamespace: input.fence.driverId,
      accountScope: input.fence.agentId,
      conversationId,
      startedAt: input.observedAt ?? input.receivedAt
    }), now);
  }
  const current = currentProviderConversation(sessions.providerBinding);
  if (current.conversationId === conversationId) {
    return sessions;
  }
  if (replacementBasis === undefined) {
    throw new Error("A fresh Provider Conversation requires a terminal prior Session.");
  }
  return updateTaskRoleProviderRuntime(
    sessions,
    supersedeProviderConversation(sessions.providerBinding, {
      conversationId,
      switchedAt: input.observedAt ?? input.receivedAt,
      basis: replacementBasis
    }),
    now
  );
}

function terminalProviderReplacementBasis(
  sessions: TaskRoleSessionSet,
  input: RuntimeObservation,
  mode: AgentRun["mode"]
): "terminal-session" | undefined {
  if (mode !== "new" || sessions.providerBinding === null) return undefined;
  if (sessions.providerBinding.providerNamespace !== input.fence.driverId
    || sessions.providerBinding.accountScope !== input.fence.agentId) {
    return undefined;
  }
  const current = sessions.sessions[input.fence.agentId];
  if (current === undefined || current.status !== "active" || current.nativeSessionId !== input.fence.nativeSessionId) {
    return undefined;
  }
  const replaced = [...(sessions.history ?? [])].reverse().find((session) => (
    session.agentId === current.agentId
    && session.adapterId === current.adapterId
    && session.status === "ended"
    && session.nativeSessionId === currentProviderConversation(sessions.providerBinding!).conversationId
  ));
  return replaced === undefined ? undefined : "terminal-session";
}

function settleStructuredProviderTurn(
  sessions: TaskRoleSessionSet,
  runId: string | undefined,
  status: "completed" | "failed" | "cancelled",
  now: Date,
  attemptId?: string
): TaskRoleSessionSet {
  const binding = sessions.providerBinding;
  if (binding === null || binding.run === null
    || (attemptId === undefined ? binding.run.nativeTurnId !== runId : binding.run.attemptId !== attemptId)) {
    return sessions;
  }
  if (["completed", "failed", "cancelled"].includes(binding.run.status)) return sessions;
  return updateTaskRoleProviderRuntime(sessions, settleProviderTurn(binding, {
    nativeTurnId: runId,
    ...(attemptId === undefined ? {} : { attemptId }),
    status,
    settledAt: now.toISOString()
  }), now);
}

/**
 * The Global twin of {@link settleStructuredProviderTurn}: settle a Global Role's
 * own live Provider Turn to the observed native terminal, keyed by the exact
 * native Turn id the real Provider Stop/StopFailure hook carries (decision-3 §9).
 * It is a strict guarded no-op unless a controller-owned Turn with that exact
 * native id is bound and still in flight (`accepted`) — an absent binding, a
 * different/only-submitting Turn, or an already-terminal one is left untouched, so
 * an older unmanaged Session without a controlled binding settles nothing
 * and the durable `recentCompletedTurnIds` terminal remains the proof of record.
 */
function settleGlobalRoleRuntimeTurn(
  sessions: GlobalRoleSessionSet,
  nativeTurnId: string,
  status: "completed" | "failed" | "cancelled",
  now: Date
): GlobalRoleSessionSet {
  const binding = sessions.providerBinding;
  if (binding === null || binding === undefined || binding.run === null
    || binding.run.nativeTurnId !== nativeTurnId
    || binding.run.status !== "accepted") {
    return sessions;
  }
  return updateGlobalRoleProviderRuntime(sessions, settleProviderTurn(binding, {
    nativeTurnId,
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
