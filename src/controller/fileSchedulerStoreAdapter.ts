import { isDeepStrictEqual } from "node:util";

import {
  activeLiveRoleAgentSession,
  bindTaskRoleRun,
  clearTaskRoleRun,
  createRoleSessionSet,
  markTaskRoleRunDelivered,
  recordObservedTaskRoleCompletion,
  recordRoleAgentSession,
  rememberRoleAgentCompletedTurn,
  settleTaskRoleCompletion,
  terminalizeTaskRoleRunSession,
  updateRoleAgentSessionStatus,
  type AgentSessionStatus,
  type GlobalRoleSessionSet,
  type RoleAgentSession,
  type TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import {
  createPendingTurnCompletion,
  hasRecentTurnId,
  type PendingTurnCompletion
} from "../executor/turnCompletion.js";
import { createTaskEvent } from "../event/taskEvent.js";
import { createTaskMessage } from "../message/message.js";
import { answerInputRequest } from "../input/inputRequest.js";
import { activeRoleAgentBinding, updateRoleStatus } from "../role/role.js";
import {
  effectiveLaunchSnapshotsCompatible,
  resolveEffectiveLaunch,
  validateEffectiveLaunchSnapshot,
  type EffectiveLaunchSnapshot
} from "../executor/effectiveLaunch.js";
import { SYSTEM_OPERATOR_ROLE } from "../role/systemRoles.js";
import {
  failAgentRun,
  markAgentRunDelivered,
  yieldAgentRun,
  type AgentRun
} from "../run/agentRun.js";
import { terminalizeExactTaskRun } from "../lifecycle/exactRunTerminalization.js";
import type { TaskClaudeStopFailureEvent } from "./runtimeEventProcessor.js";
import type {
  DormantRuntimeOwnerCandidate,
  LeaderDispatchFailurePersistence,
  LeaderDispatchClaimResult,
  LeaderDispatchPersistence,
  RoleRunDeliveryPersistence,
  SchedulerRole,
  SchedulerRoleSession,
  SchedulerStorePort,
  ExitedRoleRunPersistence
} from "../scheduler/ports.js";
import { recordLeaderFailure } from "../scheduler/leaderFailure.js";
import { createLeaderRecoveryNotification } from "../scheduler/operatorNotification.js";
import { pendingWakeupsMatch } from "../scheduler/pendingWakeup.js";
import { queueLeaderWakeup } from "../scheduler/wakeupQueue.js";
import type { TaskStore } from "../storage/taskStore.js";
import { updateWorkItemStatus } from "../workItem/workItem.js";
import {
  formatAgentRunReceiptId,
  formatTaskRecordReference
} from "../task/taskRecordReference.js";
import {
  bindExecution,
  claimPending,
  completeProcessing,
  releaseProcessing,
  type MailboxTarget,
  type WorkMailbox
} from "../coordination/workMailbox.js";
import { completeWorkExecution, enqueueWork } from "../coordination/workMailboxQueue.js";
import type { SchedulerMailboxClaimInput, SchedulerMailboxClaimResult } from "../scheduler/ports.js";
import {
  RUNTIME_CLEANUP_REQUIRED_REASON,
  RUNTIME_LAUNCH_RESERVED_REASON,
  RUNTIME_LIFECYCLE_OWNER,
  hasRuntimeCleanupObligation,
  hasRuntimeLifecycleWork,
  isRuntimeLaunchReservation,
  runtimeLifecycleTarget,
  type RuntimeLifecycleTarget,
  type RuntimeRoleOwner
} from "../runtime/lifecycleReservation.js";

/** Maps the authoritative FileTaskStore records to the scheduler's narrow port. */
export class FileSchedulerStoreAdapter implements SchedulerStorePort {
  constructor(readonly store: TaskStore) {}

  getPresentationContext() {
    return { timeZone: this.store.getConfig().timeZone };
  }
  listTasks() { return this.store.listTasks(); }
  getTask(taskId: string) { return this.store.getTask(taskId); }
  getTaskBrief(taskId: string) { return this.store.getTaskBrief(taskId); }
  listDecisions(taskId: string) { return this.store.listDecisions(taskId); }
  listMilestones(taskId: string) { return this.store.listMilestones(taskId); }

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
    return this.store.listInputRequests(taskId).some((request) => request.status === "open");
  }

  listOpenInputRequests() {
    return this.store.listAllInputRequests().filter((request) => request.status === "open");
  }

  getInputRequest(taskId: string, inputRequestId: string) {
    return this.store.getInputRequest(taskId, inputRequestId);
  }

  getOperatorDeliveryTarget() {
    const role = this.store.getGlobalRole(SYSTEM_OPERATOR_ROLE);
    if (role === null) return null;
    const sessions = this.store.getGlobalRoleSessionSet(SYSTEM_OPERATOR_ROLE);
    const effectiveSession = sessions?.sessions[sessions.activeAgentId];
    return {
      roleName: SYSTEM_OPERATOR_ROLE,
      adapterId: effectiveSession?.effective.adapterId
        ?? activeRoleAgentBinding(role).adapterId
    } as const;
  }

  resolveExpiredInputRecommendations(now: Date, taskIds?: ReadonlySet<string>) {
    return this.store.transaction((store) => {
      const expired = store.listAllInputRequests().filter((request) => (
        request.status === "open"
        && request.policy.kind === "recommended"
        && Date.parse(request.policy.timeoutAt) <= now.getTime()
        && (taskIds === undefined || taskIds.has(request.taskId))
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
        queueLeaderWakeup(store, task.id, `input-timeout:${request.id}`, now);
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

  hasInFlightTurn(taskId: string, roleName: string): boolean {
    const sessions = this.store.getTaskRoleSessionSet(taskId, roleName);
    return sessions !== null && sessions.inFlight !== null;
  }

  peekNextAgentRunId(taskId: string): string {
    return this.store.peekNextAgentRunId(taskId);
  }
  getWorkMailbox(target: MailboxTarget) { return this.store.getWorkMailbox(target); }
  listWorkMailboxes() { return this.store.listWorkMailboxes(); }

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
      if (mailbox === null || (mailbox.processing === null && mailbox.pending === null)) {
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
      if (mailbox.pending !== null) {
        if (
          mailbox.pending.reasons.length !== 1
          || mailbox.pending.reasons[0] !== RUNTIME_CLEANUP_REQUIRED_REASON
        ) {
          return false;
        }
        const batchId = `runtime-cleanup-complete:${mailbox.pending.fromSequence}-${mailbox.pending.toSequence}`;
        mailbox = completeProcessing(claimPending(mailbox, {
          batchId,
          owner: RUNTIME_LIFECYCLE_OWNER,
          startedAt: now.toISOString()
        }), batchId);
      }
      markRuntimeOwnerSessionStopped(store, runtimeOwnerFromTarget(target), now);
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
    const taskOwners = this.store.listTasks().flatMap((task) => (
      this.store.listRoleSessionSets(task.id).flatMap((sessions) => {
        const active = sessions.sessions[sessions.activeAgentId];
        return active !== undefined
          && active.status !== "stopped"
          && !hasRuntimeLifecycleWork(
            this.store.getWorkMailbox(runtimeLifecycleTarget(sessions.owner))
          )
          && this.store.getActiveAgentRun(
            task.id,
            sessions.owner.roleName
          ) === null
          ? [{
              owner: sessions.owner,
              agentId: active.agentId,
              adapterId: active.adapterId,
              nativeSessionId: active.nativeSessionId,
              sessionUpdatedAt: active.updatedAt
            }]
          : [];
      })
    ));
    const globalOwners = this.store.listGlobalRoleSessionSets().flatMap(
      (sessions) => {
        const active = sessions.sessions[sessions.activeAgentId];
        return active !== undefined
          && active.status !== "stopped"
          && !hasRuntimeLifecycleWork(
            this.store.getWorkMailbox(runtimeLifecycleTarget(sessions.owner))
          )
          ? [{
              owner: sessions.owner,
              agentId: active.agentId,
              adapterId: active.adapterId,
              nativeSessionId: active.nativeSessionId,
              sessionUpdatedAt: active.updatedAt
            }]
          : [];
      }
    );
    return [...taskOwners, ...globalOwners];
  }

  markRuntimeOwnerStopped(
    candidate: DormantRuntimeOwnerCandidate,
    now: Date
  ): boolean {
    return this.store.transaction((store) => {
      const { owner } = candidate;
      if (
        hasRuntimeLifecycleWork(
          store.getWorkMailbox(runtimeLifecycleTarget(owner))
        )
      ) {
        return false;
      }
      if (
        owner.scope === "task"
        && store.getActiveAgentRun(owner.taskId, owner.roleName) !== null
      ) {
        return false;
      }
      const sessions = owner.scope === "task"
        ? store.getTaskRoleSessionSet(owner.taskId, owner.roleName)
        : store.getGlobalRoleSessionSet(owner.roleName);
      const active = sessions?.sessions[sessions.activeAgentId];
      if (
        active === undefined
        || active.status === "stopped"
        || active.agentId !== candidate.agentId
        || active.adapterId !== candidate.adapterId
        || active.nativeSessionId !== candidate.nativeSessionId
        || active.updatedAt !== candidate.sessionUpdatedAt
      ) {
        return false;
      }
      return markRuntimeOwnerSessionStopped(store, owner, now);
    });
  }

  enqueueRuntimeCleanup(
    owner: RuntimeRoleOwner,
    now = new Date()
  ): RuntimeLifecycleTarget | null {
    return this.store.transaction((store) => {
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
      if (mailbox === null || mailbox.pending === null) return "state-changed";
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
      if (active.deliveredAt === undefined) {
        store.saveAgentRun(markAgentRunDelivered(active, input.now));
        markTaskRoleRunDeliveredInFlight(store, role, input.run, input.now);
        store.saveEvent(input.task.id, createTaskEvent(
          store.nextEventId(input.task.id),
          input.task.id,
          "run.delivered",
          runLaunchEventPayload(active),
          input.now
        ));
      } else {
        const sessions = store.getTaskRoleSessionSet(input.task.id, input.role.name);
        if (sessions?.inFlight?.runId === input.run.id
          && sessions.inFlight.deliveredAt === undefined) {
          markTaskRoleRunDeliveredInFlight(store, role, input.run, input.now);
        }
      }
      if (role.status !== "running") {
        store.saveRole(input.task.id, updateRoleStatus(role, "running", input.now));
      }
      if (input.session !== null && input.session.nativeSessionId !== undefined) {
        const existing = store.getRoleSession(input.task.id, input.role.name);
        const reservation = matchingPreparedRuntimeReservation(
          store,
          input,
          existing
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
        const reservation = matchingPreparedRuntimeReservation(
          store,
          input,
          existing
        );
        if (existing?.nativeSessionId !== input.session.nativeSessionId
          || (input.launchId !== undefined && existing.launchId !== input.launchId)
          || existing.status !== "running") {
          saveTaskSession(store, role, {
            ...input.session,
            nativeSessionId: input.session.nativeSessionId
          }, "running", input.now, input.launchId);
        }
        completePreparedRuntimeReservation(store, reservation);
      }
      bindTaskRoleRunInFlight(store, role, input.run, input.now);
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
          || sessions.inFlight.receiptId !== formatAgentRunReceiptId(task.id, currentRun.id)
        )
      ) {
        return "state-changed";
      }
      const target = { kind: "role", taskId: task.id, roleName: role.name } as const;
      const mailbox = store.getWorkMailbox(target);
      if (
        mailbox?.processing?.executionRef?.type !== "run"
        || mailbox.processing.executionRef.taskId !== task.id
        || mailbox.processing.executionRef.id !== currentRun.id
      ) {
        return "state-changed";
      }
      store.saveAgentRun(failAgentRun(currentRun, input.summary, input.now));
      store.clearActiveAgentRun(task.id, role.name);
      clearTaskRoleRunInFlight(store, role, currentRun, input.now);
      store.saveWorkMailbox(completeProcessing(mailbox, mailbox.processing.batchId));
      if (currentRun.purpose === "execution" && currentRun.workItemId !== undefined) {
        const workItem = store.getWorkItem(task.id, currentRun.workItemId);
        if (workItem !== null && !["completed", "failed", "cancelled", "superseded", "abandoned"].includes(workItem.status)) {
          store.saveWorkItem(
            task.id,
            updateWorkItemStatus(workItem, "failed", input.now, input.summary)
          );
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
        currentRun.purpose === "review"
          ? "review-failed"
          : role.name === "leader" ? "leader-run-failed" : "role-run-failed",
        input.now
      );
      return "failed";
    });
  }

  saveArchivedTaskStopped(taskId: string, now: Date): void {
    this.store.transaction((store) => {
      const task = store.getTask(taskId);
      if (task === null || task.status !== "archived") return;
      for (const role of store.listRoles(taskId)) {
        if (role.status !== "idle") {
          store.saveRole(taskId, updateRoleStatus(role, "idle", now));
        }
      }
      for (const current of store.listRoleSessionSets(taskId)) {
        if (Object.values(current.sessions).every((session) => session.status === "stopped")) {
          continue;
        }
        let updated: TaskRoleSessionSet = current;
        for (const agentId of Object.keys(current.sessions)) {
          updated = updateRoleAgentSessionStatus(updated, agentId, "stopped", now);
        }
        store.saveRoleSessionSet(updated);
      }
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
          launchId: existing!.processing!.batchId
        };
      }
      if (
        existing !== null
        && (existing.processing !== null || existing.pending !== null)
      ) {
        throw new Error("Runtime lifecycle work is already pending.");
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
      store.saveWorkMailbox(claimPending(queued, {
        batchId: input.launchId,
        owner: RUNTIME_LIFECYCLE_OWNER,
        startedAt: now.toISOString()
      }));
      return { status: "reserved", launchId: input.launchId };
    });
  }

  confirmRuntimeLaunchReservation(
    input: Readonly<{ owner: RuntimeRoleOwner; launchId: string }>,
    assertCurrent: () => void
  ): void {
    this.store.transaction((store) => {
      assertCurrent();
      requireRuntimeLaunchReservation(store, input.owner, input.launchId);
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
    launchId: string
  ): boolean {
    return this.store.transaction((store) => {
      const target = runtimeLifecycleTarget(owner);
      const mailbox = store.getWorkMailbox(target);
      if (!isRuntimeLaunchReservation(mailbox?.processing, launchId)) return false;
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
   * Fast hook path: durably records the native Turn boundary and a two-second
   * closure deadline. It never performs tmux, workspace, or Controller I/O.
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
    if (sessions?.pendingTurnCompletion !== null && sessions !== null) {
      return sessions.pendingTurnCompletion.turnId === input.turnId
        ? "apply"
        : "deferred";
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
      return cleanup || isLeaderDisposedWorkItemRun(this.store, input)
        ? "obsolete"
        : "apply";
    }
    if (input.runId === undefined || sessions.inFlight.runId !== input.runId) {
      return "obsolete";
    }
    // A matching native completion proves that this Run's prompt reached the
    // Agent even if Controller crashed before persisting the tmux receipt.
    return "apply";
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
  }>, now = new Date()): Readonly<{
    session: RoleAgentSession;
    duplicate: boolean;
    pendingRunId?: string;
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
      const pending = sessions.pendingTurnCompletion;
      if (
        effectiveExisting !== undefined
        && pending !== null
        && pending.agentId === input.agentId
        && pending.nativeSessionId === input.nativeSessionId
        && pending.turnId === input.turnId
        && pending.runId === input.runId
      ) {
        return {
          session: effectiveExisting,
          duplicate: true,
          pendingRunId: pending.runId
        };
      }
      if (sessions.inFlight === null
        && existing !== undefined
        && (
          hasRuntimeCleanupObligation(store.getWorkMailbox(runtimeLifecycleTarget(owner)))
          || isLeaderDisposedWorkItemRun(store, input)
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
        status: sessions.inFlight === null ? idleStatus : "running",
        effective
      }, now);
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
        return { session: sessions.sessions[input.agentId]!, duplicate: false };
      }

      const fence = {
        agentId: sessions.inFlight.agentId,
        runId: sessions.inFlight.runId,
        receiptId: sessions.inFlight.receiptId
      };
      if (sessions.inFlight.deliveredAt === undefined) {
        const active = store.getActiveAgentRun(task.id, role.name);
        if (active === null || active.id !== fence.runId || active.status !== "active") {
          return { session: sessions.sessions[input.agentId]!, duplicate: false };
        }
        if (active.deliveredAt === undefined) {
          store.saveAgentRun(markAgentRunDelivered(active, now));
        }
        sessions = markTaskRoleRunDelivered(sessions, fence, now);
      }
      const completion = createPendingTurnCompletion({
        taskId: task.id,
        roleName: role.name,
        agentId: input.agentId,
        nativeSessionId: input.nativeSessionId,
        turnId: input.turnId,
        runId: fence.runId,
        summary: input.summary,
        observedAt: now,
        dueAt: new Date(now.getTime() + 2_000)
      });
      sessions = recordObservedTaskRoleCompletion(sessions, completion);
      const active = store.getActiveAgentRun(task.id, role.name);
      if (active === null || active.id !== fence.runId || active.status !== "active") {
        sessions = settleTaskRoleCompletion(sessions, {
          agentId: input.agentId,
          runId: fence.runId,
          turnId: input.turnId
        }, now);
        sessions = updateRoleAgentSessionStatus(sessions, input.agentId, "ready", now);
        store.saveTaskRoleSessionSet(sessions);
        completeRuntimeHookReservation(store, owner, input.launchId);
        return { session: sessions.sessions[input.agentId]!, duplicate: false };
      }
      store.saveTaskRoleSessionSet(sessions);
      completeRuntimeHookReservation(store, owner, input.launchId);
      return {
        session: sessions.sessions[input.agentId]!,
        duplicate: false,
        pendingRunId: fence.runId
      };
    });
  }

  listPendingRuntimeTurnCompletions(): readonly PendingTurnCompletion[] {
    return this.store.listTasks().flatMap((task) => (
      this.store.listRoleSessionSets(task.id).flatMap((sessions) => (
        sessions.pendingTurnCompletion === null ? [] : [sessions.pendingTurnCompletion]
      ))
    ));
  }

  /** Resolves only completions whose grace deadline has elapsed. */
  resolveDueRuntimeTurnCompletions(
    now: Date,
    taskIds?: ReadonlySet<string>
  ): readonly string[] {
    const due = this.listPendingRuntimeTurnCompletions().filter((completion) => (
      Date.parse(completion.dueAt) <= now.getTime()
      && (taskIds === undefined || taskIds.has(completion.taskId))
    ));
    const finalized: string[] = [];
    for (const completion of due) {
      this.store.transaction((store) => {
        const current = store.getTaskRoleSessionSet(completion.taskId, completion.roleName);
        if (current === null) return;
        const pending = current.pendingTurnCompletion;
        if (
          pending === null
          || pending.turnId !== completion.turnId
          || pending.runId !== completion.runId
        ) return;
        const active = store.getActiveAgentRun(completion.taskId, completion.roleName);
        if (active?.id === completion.runId) {
          const result = this.recordRuntimeTurnCompleted({
            taskId: completion.taskId,
            roleName: completion.roleName,
            agentId: completion.agentId,
            adapterId: current.sessions[completion.agentId]!.adapterId,
            nativeSessionId: completion.nativeSessionId,
            turnId: completion.turnId,
            expectedRunId: completion.runId,
            summary: completion.summary
          }, now);
          if (result.finalizedRunId !== undefined) {
            finalized.push(formatTaskRecordReference(
              completion.taskId,
              result.finalizedRunId,
              "agentRun"
            ));
          }
        }
        let settled = store.getTaskRoleSessionSet(completion.taskId, completion.roleName);
        if (settled?.pendingTurnCompletion?.turnId !== completion.turnId) return;
        settled = settleTaskRoleCompletion(settled, {
          agentId: completion.agentId,
          runId: completion.runId,
          turnId: completion.turnId
        }, now);
        settled = updateRoleAgentSessionStatus(settled, completion.agentId, "ready", now);
        store.saveTaskRoleSessionSet(settled);
      });
    }
    return finalized;
  }

  /**
   * Codex has returned to its composer. A delivered Leader control Run cannot
   * remain active past this boundary: doing so would permanently fence later
   * Worker-result wakeups behind a process that is alive but no longer busy.
   */
  recordRuntimeTurnCompleted(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    launchId?: string;
    nativeSessionId: string;
    turnId: string;
    expectedRunId?: string;
    summary: string;
  }>, now = new Date()): Readonly<{
    session: RoleAgentSession;
    finalizedRunId?: string;
  }> {
    return this.store.transaction((store) => {
      const task = store.getTask(input.taskId);
      if (task === null) throw new Error(`Task not found: ${input.taskId}.`);
      if (task.status !== "active") {
        throw new Error(`Cannot complete a runtime turn for inactive Task: ${input.taskId}.`);
      }
      const role = requireRole(store, input.taskId, input.roleName);
      const current = store.getRoleSessionSet(input.taskId, input.roleName)
        ?? createRoleSessionSet(
          { scope: "task", taskId: input.taskId, roleName: input.roleName },
          input.agentId,
          now
        );
      const existing = current.sessions[input.agentId];
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
      const sessions = effectiveExisting?.status === "ready"
        ? current
        : recordRoleAgentSession(current, {
            agentId: input.agentId,
            adapterId: input.adapterId,
            nativeSessionId: input.nativeSessionId,
            ...(input.launchId === undefined ? {} : { launchId: input.launchId }),
            policy: "fixed",
            status: "ready",
            effective
          }, now);
      if (
        input.expectedRunId !== undefined
        && store.getActiveAgentRun(task.id, role.name)?.id !== input.expectedRunId
      ) {
        return { session: sessions.sessions[input.agentId]! };
      }
      if (sessions !== current) store.saveRoleSessionSet(sessions);
      completeRuntimeHookReservation(store, owner, input.launchId);
      const session = sessions.sessions[input.agentId]!;

      const active = store.getActiveAgentRun(task.id, role.name);
      if (
        task.status !== "active"
        || active === null
        || active.deliveredAt === undefined
        || (input.expectedRunId !== undefined && active.id !== input.expectedRunId)
      ) {
        return { session };
      }

      if (role.name !== "leader" || active.workItemId !== undefined) {
        const summary = `Role turn completed without yui task run yield. Last assistant message: ${input.summary}`;
        const terminal = failAgentRun(active, summary, now);
        const target = { kind: "role", taskId: task.id, roleName: role.name } as const;
        store.saveAgentRun(terminal);
        if (!completeWorkExecution(store, target, {
          type: "run",
          taskId: task.id,
          id: terminal.id
        })) {
          throw new Error(`Role Run mailbox execution is inconsistent: ${terminal.id}.`);
        }
        store.clearActiveAgentRun(task.id, role.name);
        store.saveTaskRoleSessionSet(terminalizeTaskRoleRunSession(
          store.getTaskRoleSessionSet(task.id, role.name)!,
          {
            agentId: active.effective.agentId,
            runId: active.id,
            receiptId: formatAgentRunReceiptId(task.id, active.id)
          },
          now
        ));
        if (active.purpose === "execution" && active.workItemId !== undefined) {
          const item = store.getWorkItem(task.id, active.workItemId);
          if (item !== null && !["completed", "failed", "cancelled", "superseded", "abandoned"].includes(item.status)) {
            store.saveWorkItem(
              task.id,
              updateWorkItemStatus(item, "failed", now, summary)
            );
          }
        }
        store.saveRole(task.id, updateRoleStatus(role, "idle", now));
        enqueueWork(
          store,
          { kind: "role", taskId: task.id, roleName: "leader" },
          "role-run-failed",
          now,
          [
            { type: "run", taskId: task.id, id: terminal.id },
            ...(terminal.workItemId === undefined
              ? []
              : [{
                  type: "work-item" as const,
                  taskId: task.id,
                  id: terminal.workItemId
                }])
          ]
        );
        return { session, finalizedRunId: terminal.id };
      }

      const terminal = yieldAgentRun(active, input.summary, now);
      const leaderTarget = { kind: "role", taskId: task.id, roleName: role.name } as const;
      const leaderMailbox = store.getWorkMailbox(leaderTarget);
      const recoveryTurn = leaderMailbox?.processing?.executionRef?.type === "run"
        && leaderMailbox.processing.executionRef.taskId === task.id
        && leaderMailbox.processing.executionRef.id === active.id
        && leaderMailbox.processing.batch.reasons.includes("leader-turn-unclosed");
      const quiescent = leaderMailbox?.pending === null
        && !store.listRoles(task.id).some((candidate) => (
          candidate.name !== "leader"
          && store.getActiveAgentRun(task.id, candidate.name) !== null
        ))
        && !store.listWorkItems(task.id).some((item) => item.status === "running")
        && !store.listInputRequests(task.id).some((request) => request.status === "open");
      const message = createTaskMessage(
        store.nextMessageId(task.id),
        task.id,
        input.summary,
        "role-result",
        { type: "role", roleName: role.name },
        now,
        { runId: terminal.id }
      );
      store.saveAgentRun(terminal);
      store.saveMessage(task.id, message);
      store.saveEvent(task.id, createTaskEvent(
        store.nextEventId(task.id),
        task.id,
        "message.sent",
        { messageId: message.id, kind: message.kind },
        now
      ));
      if (!completeWorkExecution(
        store,
        leaderTarget,
        { type: "run", taskId: task.id, id: terminal.id }
      )) {
        throw new Error(`Leader Run mailbox execution is inconsistent: ${terminal.id}.`);
      }
      store.clearActiveAgentRun(task.id, role.name);
      store.saveTaskRoleSessionSet(terminalizeTaskRoleRunSession(
        store.getTaskRoleSessionSet(task.id, role.name)!,
        {
          agentId: active.effective.agentId,
          runId: active.id,
          receiptId: formatAgentRunReceiptId(task.id, active.id)
        },
        now
      ));
      store.saveRole(task.id, updateRoleStatus(role, "idle", now));
      if (quiescent) {
        if (recoveryTurn) {
          const message = "Leader ended a recovery Turn without completing, blocking, or continuing the Task.";
          store.saveLeaderFailure(recordLeaderFailure(
            task.id,
            input.nativeSessionId,
            message,
            now,
            store.getLeaderFailure(task.id)
          ));
          store.saveOperatorNotification(createLeaderRecoveryNotification(
            task.id,
            message,
            now,
            store.getOperatorNotification(task.id)
          ));
          store.saveRole(task.id, updateRoleStatus(role, "failed", now));
          enqueueWork(
            store,
            { kind: "operator" },
            "leader-recovery-failed",
            now,
            [
              { type: "task", id: task.id },
              { type: "run", taskId: task.id, id: terminal.id }
            ]
          );
        } else {
          enqueueWork(
            store,
            leaderTarget,
            "leader-turn-unclosed",
            now,
            [
              { type: "task", id: task.id },
              { type: "run", taskId: task.id, id: terminal.id }
            ]
          );
        }
      }
      return { session, finalizedRunId: terminal.id };
    });
  }

  classifyClaudeStopFailureEvent(
    input: TaskClaudeStopFailureEvent
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
      || run.effective.adapterId !== "claude"
      || input.adapterId !== "claude"
    ) return "obsolete";
    const sessions = this.store.getTaskRoleSessionSet(input.taskId, input.roleName);
    const session = sessions?.sessions[input.agentId];
    if (
      sessions === null
      || session?.nativeSessionId !== input.nativeSessionId
      || session.launchId !== input.launchId
      || sessions.inFlight?.agentId !== input.agentId
      || sessions.inFlight.runId !== input.runId
      || sessions.inFlight.receiptId !== `agent-run:${input.taskId}/${input.runId}`
    ) return "obsolete";
    return "apply";
  }

  observeClaudeStopFailureEvent(
    input: TaskClaudeStopFailureEvent,
    now = new Date()
  ): Readonly<{ disposition: "applied" | "obsolete"; runId: string }> {
    return this.store.transaction((store) => {
      const before = store.getAgentRun(input.taskId, input.runId);
      if (before === null) {
        recordObsoleteRuntimeEvent(store, input, "run-missing", now);
        return { disposition: "obsolete", runId: input.runId };
      }
      const summary = claudeStopFailureSummary(input);
      const result = terminalizeExactTaskRun(store, {
        taskId: input.taskId,
        roleName: input.roleName,
        agentId: input.agentId,
        runId: input.runId,
        receiptId: `agent-run:${input.taskId}/${input.runId}`,
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

      const terminal = result.run;
      const message = createTaskMessage(
        store.nextMessageId(input.taskId),
        input.taskId,
        summary,
        "role-result",
        { type: "role", roleName: input.roleName },
        now,
        {
          runId: input.runId,
          ...(before.workItemId === undefined ? {} : { workItemId: before.workItemId })
        }
      );
      store.saveMessage(input.taskId, message);
      store.saveEvent(input.taskId, createTaskEvent(
        store.nextEventId(input.taskId),
        input.taskId,
        "message.sent",
        { messageId: message.id, kind: message.kind },
        now
      ));

      if (before.purpose === "execution" && before.workItemId !== undefined) {
        const item = store.getWorkItem(input.taskId, before.workItemId);
        if (item !== null && ![
          "completed", "failed", "cancelled", "superseded", "abandoned"
        ].includes(item.status)) {
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
        "runtime.claude-stop-failure",
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
            { type: "message", taskId: input.taskId, id: message.id },
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

function claudeStopFailureSummary(input: TaskClaudeStopFailureEvent): string {
  return [
    "Claude StopFailure.",
    `error: ${input.error}`,
    ...(input.errorDetails === undefined
      ? []
      : [`error_details: ${input.errorDetails}`]),
    ...(input.lastAssistantMessage === undefined
      ? []
      : [`last_assistant_message: ${input.lastAssistantMessage}`])
  ].join("\n");
}

function recordObsoleteRuntimeEvent(
  store: TaskStore,
  input: Readonly<{
    eventId: string;
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
    && event.payload.eventId === input.eventId
  ))) return;
  store.saveEvent(input.taskId, createTaskEvent(
    store.nextEventId(input.taskId),
    input.taskId,
    "runtime.event-obsolete",
    {
      eventId: input.eventId,
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
  if (mailbox.processing === null && mailbox.pending === null) {
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

function matchingPreparedRuntimeReservation(
  store: TaskStore,
  input: Readonly<{
    task: { id: string };
    role: { name: string };
    session: SchedulerRoleSession | null;
    launchId?: string;
  }>,
  existing: SchedulerRoleSession | null
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
    && !hasRuntimeCleanupObligation(mailbox)
  ) {
    return mailbox;
  }
  if (
    existing?.agentId === input.session.agentId
    && existing.adapterId === input.session.adapterId
    && existing.nativeSessionId === input.session.nativeSessionId
  ) {
    return null;
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
  if (!effectiveLaunchSnapshotsCompatible(resolvedEffective, effective)) {
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
    effective
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
  const workspace = store.getRoleWorkspace(role.taskId, role.name) ?? undefined;
  const effective = activeLiveRoleAgentSession(
    store.getTaskRoleSessionSet(role.taskId, role.name)
  )?.effective ?? resolveEffectiveLaunch({
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
    return active.effective;
  }
  if (existing !== undefined) return existing.effective;
  const role = store.getRole(taskId, roleName);
  if (role === null) throw new Error(`Role not found: ${taskId}/${roleName}.`);
  const workspace = store.getRoleWorkspace(taskId, roleName)
    ?? store.getRoleWorkspace(taskId, "leader")
    ?? undefined;
  const item = workspace?.owner.type === "work-item"
    ? store.getWorkItem(taskId, workspace.owner.workItemId)
    : null;
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
    status: session.status,
    effective: session.effective
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
    policy: "fixed",
    status,
    effective: session.effective
  }, now);
  store.saveRoleSessionSet(updated);
}

function bindTaskRoleRunInFlight(
  store: TaskStore,
  role: NonNullable<ReturnType<TaskStore["getRole"]>>,
  run: { id: string; effective: { agentId: string } },
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
    if (current.inFlight !== null || current.pendingTurnCompletion !== null) {
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
    receiptId: formatAgentRunReceiptId(role.taskId, run.id)
  }, now);
  store.saveRoleSessionSet(updated);
}

function markTaskRoleRunDeliveredInFlight(
  store: TaskStore,
  role: NonNullable<ReturnType<TaskStore["getRole"]>>,
  run: { id: string; effective: { agentId: string } },
  now: Date
): void {
  const current = store.getRoleSessionSet(role.taskId, role.name);
  if (current === null) {
    throw new Error(`Task Role session set is missing for delivered Run: ${run.id}.`);
  }
  const updated = markTaskRoleRunDelivered(current, {
    agentId: run.effective.agentId,
    runId: run.id,
    receiptId: formatAgentRunReceiptId(role.taskId, run.id)
  }, now);
  store.saveRoleSessionSet(updated);
}

function clearTaskRoleRunInFlight(
  store: TaskStore,
  role: NonNullable<ReturnType<TaskStore["getRole"]>>,
  run: { id: string; effective: { agentId: string } },
  now: Date
): void {
  const current = store.getRoleSessionSet(role.taskId, role.name);
  if (current === null) return;
  if (current.inFlight?.runId !== run.id) return;
  const updated = clearTaskRoleRun(current, {
    agentId: run.effective.agentId,
    runId: run.id,
    receiptId: formatAgentRunReceiptId(role.taskId, run.id)
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
    && isDeepStrictEqual(current.effective, expected.effective);
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
    effectiveAccess: run.effective.access,
    provenance: run.effective.provenance,
    writeProjectIds: run.effective.writeProjectIds.join(",") || "none"
  };
}
