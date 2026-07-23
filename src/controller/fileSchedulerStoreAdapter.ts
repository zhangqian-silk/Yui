import {
  bindTaskRoleRun,
  clearTaskRoleRun,
  createRoleSessionSet,
  markTaskRoleRunDelivered,
  recordObservedTaskRoleCompletion,
  recordRoleAgentSession,
  rememberRoleAgentCompletedTurn,
  settleTaskRoleCompletion,
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
import { SYSTEM_OPERATOR_ROLE } from "../role/systemRoles.js";
import { failAgentRun, markAgentRunDelivered, yieldAgentRun } from "../run/agentRun.js";
import type {
  LeaderDispatchFailurePersistence,
  LeaderDispatchClaimResult,
  LeaderDispatchPersistence,
  RoleRunDeliveryPersistence,
  SchedulerRole,
  SchedulerRoleSession,
  SchedulerStorePort,
  ExitedRoleRunPersistence
} from "../scheduler/ports.js";
import { pendingWakeupsMatch } from "../scheduler/pendingWakeup.js";
import { queueLeaderWakeup } from "../scheduler/wakeupQueue.js";
import type { TaskStore } from "../storage/taskStore.js";
import { completeTask } from "../task/task.js";
import { updateWorkItemStatus } from "../workItem/workItem.js";
import {
  bindExecution,
  claimPending,
  completeProcessing,
  releaseProcessing,
  type MailboxTarget
} from "../coordination/workMailbox.js";
import { completeWorkExecution, enqueueWork } from "../coordination/workMailboxQueue.js";
import type { SchedulerMailboxClaimInput, SchedulerMailboxClaimResult } from "../scheduler/ports.js";

/** Maps the authoritative FileTaskStore records to the scheduler's narrow port. */
export class FileSchedulerStoreAdapter implements SchedulerStorePort {
  constructor(readonly store: TaskStore) {}

  listTasks() { return this.store.listTasks(); }
  getTask(taskId: string) { return this.store.getTask(taskId); }
  getTaskBrief(taskId: string) { return this.store.getTaskBrief(taskId); }
  listDecisions(taskId: string) { return this.store.listDecisions(taskId); }
  listMilestones(taskId: string) { return this.store.listMilestones(taskId); }

  listRoles(taskId: string): SchedulerRole[] {
    return this.store.listRoles(taskId).map(mapRole);
  }

  getRole(taskId: string, roleName: string): SchedulerRole | null {
    const role = this.store.getRole(taskId, roleName);
    return role === null ? null : mapRole(role);
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

  getInputRequest(inputRequestId: string) {
    return this.store.findInputRequest(inputRequestId);
  }

  getOperatorDeliveryTarget() {
    const role = this.store.getGlobalRole(SYSTEM_OPERATOR_ROLE);
    if (role === null) return null;
    return {
      roleName: SYSTEM_OPERATOR_ROLE,
      adapterId: activeRoleAgentBinding(role).adapterId
    } as const;
  }

  resolveExpiredInputRecommendations(now: Date) {
    return this.store.transaction((store) => {
      const expired = store.listAllInputRequests().filter((request) => (
        request.status === "open"
        && request.policy.kind === "recommended"
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

  getRoleSession(taskId: string, roleName: string): SchedulerRoleSession | null {
    const session = this.store.getRoleSession(taskId, roleName);
    return session === null ? null : mapSession(session);
  }

  hasInFlightTurn(taskId: string, roleName: string): boolean {
    const sessions = this.store.getTaskRoleSessionSet(taskId, roleName);
    return sessions !== null && sessions.inFlight !== null;
  }

  nextAgentRunId(taskId: string): string { return this.store.nextAgentRunId(taskId); }
  getWorkMailbox(target: MailboxTarget) { return this.store.getWorkMailbox(target); }
  listWorkMailboxes() { return this.store.listWorkMailboxes(); }

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
      store.saveWorkMailbox(completeProcessing(mailbox, batchId));
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
      if (role.activeAgentId !== input.role.activeAgentId
        || activeRoleAgentBinding(role).adapterId !== input.role.adapterId) {
        return "state-changed";
      }
      if (store.getActiveAgentRun(input.task.id, input.role.name) !== null) return "busy";
      const pending = store.getPendingWakeup(input.task.id);
      if (pending === null || !pendingWakeupsMatch(pending, input.wakeup)) {
        return "state-changed";
      }
      const target = { kind: "role", taskId: input.task.id, roleName: input.role.name } as const;
      const mailbox = store.getWorkMailbox(target);
      if (mailbox === null || mailbox.pending === null) return "state-changed";
      if (mailbox.processing !== null) return "busy";
      const batchId = `agent-run:${input.run.id}`;
      const claimed = bindExecution(
        claimPending(mailbox, {
          batchId,
          owner: "controller",
          startedAt: input.now.toISOString()
        }),
        batchId,
        { type: "run", id: input.run.id }
      );
      store.saveActiveAgentRun(input.run);
      store.saveWorkMailbox(claimed);
      store.saveRole(input.task.id, updateRoleStatus(role, "running", input.now));
      bindTaskRoleRunInFlight(store, role, input.run, input.now);
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
        if (
          existing?.agentId !== input.session.agentId
          || existing.adapterId !== input.session.adapterId
          || existing.nativeSessionId !== input.session.nativeSessionId
          || existing.status !== "running"
        ) {
          saveTaskSession(store, role, {
            ...input.session,
            nativeSessionId: input.session.nativeSessionId
          }, "running", input.now);
        }
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
        if (existing?.nativeSessionId !== input.session.nativeSessionId
          || existing.status !== "running") {
          saveTaskSession(store, role, {
            ...input.session,
            nativeSessionId: input.session.nativeSessionId
          }, "running", input.now);
        }
      }
      bindTaskRoleRunInFlight(store, role, input.run, input.now);
    });
  }

  saveLeaderDispatchFailure(input: LeaderDispatchFailurePersistence): void {
    this.store.transaction((store) => {
      const task = store.getTask(input.task.id);
      if (task === null || task.status !== "active") return;
      const role = requireRole(store, input.task.id, input.role.name);
      if (input.claimed !== undefined) {
        const active = store.getActiveAgentRun(input.task.id, input.role.name);
        if (active?.id === input.claimed.run.id) {
          store.saveAgentRun(failAgentRun(active, input.failure.message, input.now));
          store.clearActiveAgentRun(input.task.id, input.role.name);
          clearTaskRoleRunInFlight(store, role, input.claimed.run, input.now);
        }
        const target = { kind: "role", taskId: input.task.id, roleName: input.role.name } as const;
        const mailbox = store.getWorkMailbox(target);
        if (mailbox?.processing?.executionRef?.type === "run"
          && mailbox.processing.executionRef.id === input.claimed.run.id) {
          store.saveWorkMailbox(releaseProcessing(mailbox, mailbox.processing.batchId));
        }
      }
      store.saveRole(input.task.id, updateRoleStatus(role, "failed", input.now));
      breakTaskSessionIfPresent(store, input.task.id, role.name, role.activeAgentId, input.now);
      store.saveLeaderFailure(input.failure);
      store.saveOperatorNotification(input.notification);
    });
  }

  saveExitedRoleRun(input: ExitedRoleRunPersistence): void {
    this.store.transaction((store) => {
      const role = requireRole(store, input.task.id, input.role.name);
      store.saveAgentRun(failAgentRun(input.run, input.summary, input.now));
      store.clearActiveAgentRun(input.task.id, input.role.name);
      clearTaskRoleRunInFlight(store, role, input.run, input.now);
      const target = { kind: "role", taskId: input.task.id, roleName: input.role.name } as const;
      const mailbox = store.getWorkMailbox(target);
      if (mailbox?.processing?.executionRef?.type === "run"
        && mailbox.processing.executionRef.id === input.run.id) {
        store.saveWorkMailbox(completeProcessing(mailbox, mailbox.processing.batchId));
      }
      if (input.run.workItemId !== undefined) {
        const workItem = store.getWorkItem(input.task.id, input.run.workItemId);
        if (workItem !== null && !["completed", "failed", "cancelled", "superseded"].includes(workItem.status)) {
          store.saveWorkItem(
            input.task.id,
            updateWorkItemStatus(workItem, "failed", input.summary, input.now)
          );
        }
      }
      store.saveRole(input.task.id, updateRoleStatus(role, "exited", input.now));
      stopTaskSessionIfPresent(store, input.task.id, role.name, role.activeAgentId, input.now);
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
    nativeSessionId: string;
  }>, now = new Date()): RoleAgentSession {
    return this.store.transaction((store) => {
      const task = store.getTask(input.taskId);
      if (task === null) throw new Error(`Task not found: ${input.taskId}.`);
      if (task.status === "archived") {
        throw new Error(`Cannot register a native session for archived Task: ${input.taskId}.`);
      }
      if (task.status !== "active") {
        throw new Error(`Cannot register a native session for a Task that is not active: ${input.taskId}.`);
      }
      const role = requireRole(store, input.taskId, input.roleName);
      const binding = activeRoleAgentBinding(role);
      if (binding.agentId !== input.agentId || binding.adapterId !== input.adapterId) {
        throw new Error("Native session registration does not match the active Role Agent binding.");
      }
      const current = store.getRoleSessionSet(input.taskId, input.roleName)
        ?? createRoleSessionSet(
          { scope: "task", taskId: input.taskId, roleName: input.roleName },
          role.activeAgentId,
          now
        );
      const existing = current.sessions[input.agentId];
      if (existing !== undefined && existing.nativeSessionId !== input.nativeSessionId) {
        throw new Error("Native session registration conflicts with the fixed Role session.");
      }
      if (existing?.status === "running") return existing;
      const updated = recordRoleAgentSession(current, {
        agentId: input.agentId,
        adapterId: input.adapterId,
        nativeSessionId: input.nativeSessionId,
        policy: "fixed",
        status: "running"
      }, now);
      store.saveRoleSessionSet(updated);
      return updated.sessions[input.agentId]!;
    });
  }

  /**
   * Fast hook path: durably records the native Turn boundary and a two-second
   * closure deadline. It never performs tmux, workspace, or Controller I/O.
   */
  observeRuntimeTurnCompleted(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId: string;
    turnId: string;
    summary: string;
  }>, now = new Date()): Readonly<{
    session: RoleAgentSession;
    duplicate: boolean;
    pendingRunId?: string;
  }> {
    return this.store.transaction((store) => {
      const task = store.getTask(input.taskId);
      if (task === null) throw new Error(`Task not found: ${input.taskId}.`);
      if (task.status === "archived") {
        throw new Error(`Cannot complete a runtime turn for archived Task: ${input.taskId}.`);
      }
      const role = requireRole(store, input.taskId, input.roleName);
      const binding = activeRoleAgentBinding(role);
      if (binding.agentId !== input.agentId || binding.adapterId !== input.adapterId) {
        throw new Error("Runtime turn completion does not match the active Role Agent binding.");
      }
      let sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName)
        ?? createRoleSessionSet(
          { scope: "task", taskId: input.taskId, roleName: input.roleName },
          role.activeAgentId,
          now
        );
      const existing = sessions.sessions[input.agentId];
      if (existing !== undefined && existing.nativeSessionId !== input.nativeSessionId) {
        throw new Error("Runtime turn completion conflicts with the fixed Role session.");
      }
      if (existing !== undefined && hasRecentTurnId(existing.recentCompletedTurnIds, input.turnId)) {
        return { session: existing, duplicate: true };
      }
      sessions = recordRoleAgentSession(sessions, {
        agentId: input.agentId,
        adapterId: input.adapterId,
        nativeSessionId: input.nativeSessionId,
        policy: "fixed",
        status: sessions.inFlight === null ? "ready" : "running"
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
        return { session: sessions.sessions[input.agentId]!, duplicate: false };
      }

      const fence = {
        agentId: sessions.inFlight.agentId,
        runId: sessions.inFlight.runId,
        receiptId: sessions.inFlight.receiptId
      };
      if (sessions.inFlight.deliveredAt === undefined) {
        sessions = markTaskRoleRunDelivered(sessions, fence, now);
        const active = store.getActiveAgentRun(task.id, role.name);
        if (active?.id === fence.runId && active.deliveredAt === undefined) {
          store.saveAgentRun(markAgentRunDelivered(active, now));
        }
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
        return { session: sessions.sessions[input.agentId]!, duplicate: false };
      }
      store.saveTaskRoleSessionSet(sessions);
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
            summary: completion.summary
          }, now);
          if (result.finalizedRunId !== undefined) finalized.push(result.finalizedRunId);
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
    nativeSessionId: string;
    turnId: string;
    summary: string;
  }>, now = new Date()): Readonly<{
    session: RoleAgentSession;
    finalizedRunId?: string;
  }> {
    return this.store.transaction((store) => {
      const task = store.getTask(input.taskId);
      if (task === null) throw new Error(`Task not found: ${input.taskId}.`);
      if (task.status === "archived") {
        throw new Error(`Cannot complete a runtime turn for archived Task: ${input.taskId}.`);
      }
      const role = requireRole(store, input.taskId, input.roleName);
      const binding = activeRoleAgentBinding(role);
      if (binding.agentId !== input.agentId || binding.adapterId !== input.adapterId) {
        throw new Error("Runtime turn completion does not match the active Role Agent binding.");
      }
      const current = store.getRoleSessionSet(input.taskId, input.roleName)
        ?? createRoleSessionSet(
          { scope: "task", taskId: input.taskId, roleName: input.roleName },
          role.activeAgentId,
          now
        );
      const existing = current.sessions[input.agentId];
      if (existing !== undefined && existing.nativeSessionId !== input.nativeSessionId) {
        throw new Error("Runtime turn completion conflicts with the fixed Role session.");
      }
      const sessions = existing?.status === "ready"
        ? current
        : recordRoleAgentSession(current, {
            agentId: input.agentId,
            adapterId: input.adapterId,
            nativeSessionId: input.nativeSessionId,
            policy: "fixed",
            status: "ready"
          }, now);
      if (sessions !== current) store.saveRoleSessionSet(sessions);
      const session = sessions.sessions[input.agentId]!;

      const active = store.getActiveAgentRun(task.id, role.name);
      if (
        task.status !== "active"
        || active === null
        || active.deliveredAt === undefined
      ) {
        return { session };
      }

      if (role.name !== "leader" || active.workItemId !== undefined) {
        const summary = `Role turn completed without yui task run yield. Last assistant message: ${input.summary}`;
        const terminal = failAgentRun(active, summary, now);
        const target = { kind: "role", taskId: task.id, roleName: role.name } as const;
        store.saveAgentRun(terminal);
        if (!completeWorkExecution(store, target, { type: "run", id: terminal.id })) {
          throw new Error(`Role Run mailbox execution is inconsistent: ${terminal.id}.`);
        }
        store.clearActiveAgentRun(task.id, role.name);
        if (active.workItemId !== undefined) {
          const item = store.getWorkItem(task.id, active.workItemId);
          if (item !== null && !["completed", "failed", "cancelled", "superseded"].includes(item.status)) {
            store.saveWorkItem(
              task.id,
              updateWorkItemStatus(item, "failed", summary, now)
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
            { type: "run", id: terminal.id },
            ...(terminal.workItemId === undefined
              ? []
              : [{ type: "work-item" as const, id: terminal.workItemId }])
          ]
        );
        return { session, finalizedRunId: terminal.id };
      }

      const terminal = yieldAgentRun(active, input.summary, now);
      const leaderTarget = { kind: "role", taskId: task.id, roleName: role.name } as const;
      const leaderMailbox = store.getWorkMailbox(leaderTarget);
      const resultDrivenTurn = leaderMailbox?.processing?.executionRef?.type === "run"
        && leaderMailbox.processing.executionRef.id === active.id
        && leaderMailbox.processing.batch.reasons.includes("role-result");
      const quiescent = leaderMailbox?.pending === null
        && !store.listRoles(task.id).some((candidate) => (
          candidate.name !== "leader"
          && store.getActiveAgentRun(task.id, candidate.name) !== null
        ))
        && !store.listWorkItems(task.id).some((item) => item.status === "running")
        && !store.listInputRequests(task.id).some((request) => request.status === "open");
      const message = createTaskMessage(
        store.nextMessageId(task.id),
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
        "message.sent",
        { messageId: message.id, kind: message.kind },
        now
      ));
      if (!completeWorkExecution(
        store,
        leaderTarget,
        { type: "run", id: terminal.id }
      )) {
        throw new Error(`Leader Run mailbox execution is inconsistent: ${terminal.id}.`);
      }
      store.clearActiveAgentRun(task.id, role.name);
      store.saveRole(task.id, updateRoleStatus(role, "idle", now));
      if (resultDrivenTurn && quiescent) {
        const completed = completeTask(task, now, { by: "leader", summary: input.summary });
        store.saveTask(completed);
        store.clearPendingWakeup(task.id);
        store.clearLeaderFailure(task.id);
        store.clearOperatorNotification(task.id);
        store.saveEvent(task.id, createTaskEvent(
          store.nextEventId(task.id),
          "task.completed",
          { by: "leader", summary: input.summary },
          now
        ));
        enqueueWork(
          store,
          { kind: "task", taskId: task.id },
          "task-completed",
          now,
          [{ type: "task", id: task.id }]
        );
      }
      return { session, finalizedRunId: terminal.id };
    });
  }

  recordGlobalRuntimeNativeSession(input: Readonly<{
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId: string;
  }>, now = new Date()): RoleAgentSession {
    return this.store.transaction((store) => {
      const role = store.getGlobalRole(input.roleName);
      if (role === null) throw new Error(`Global Role not found: ${input.roleName}.`);
      const binding = activeRoleAgentBinding(role);
      if (binding.agentId !== input.agentId || binding.adapterId !== input.adapterId) {
        throw new Error("Native session registration does not match the active global Role Agent binding.");
      }
      const current: GlobalRoleSessionSet = store.getGlobalRoleSessionSet(input.roleName)
        ?? createRoleSessionSet(
          { scope: "global", roleName: input.roleName },
          role.activeAgentId,
          now
        );
      const existing = current.sessions[input.agentId];
      if (existing !== undefined && existing.nativeSessionId !== input.nativeSessionId) {
        throw new Error("Native session registration conflicts with the fixed global Role session.");
      }
      if (existing?.status === "running") return existing;
      const updated = recordRoleAgentSession(current, {
        agentId: input.agentId,
        adapterId: input.adapterId,
        nativeSessionId: input.nativeSessionId,
        policy: "fixed",
        status: "running"
      }, now);
      store.saveGlobalRoleSessionSet(updated);
      return updated.sessions[input.agentId]!;
    });
  }
}

function mapRole(role: ReturnType<TaskStore["getRole"]> extends infer _T ? NonNullable<ReturnType<TaskStore["getRole"]>> : never): SchedulerRole {
  const binding = activeRoleAgentBinding(role);
  return {
    taskId: role.taskId,
    name: role.name,
    activeAgentId: role.activeAgentId,
    adapterId: binding.adapterId,
    workspace: role.workspace,
    status: role.status
  };
}

function mapSession(session: RoleAgentSession): SchedulerRoleSession {
  return {
    agentId: session.agentId,
    adapterId: session.adapterId,
    nativeSessionId: session.nativeSessionId,
    status: session.status
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
      role.activeAgentId,
      now
    );
  const updated = recordRoleAgentSession(current, {
    agentId: session.agentId,
    adapterId: session.adapterId,
    nativeSessionId: session.nativeSessionId,
    policy: "fixed",
    status
  }, now);
  store.saveRoleSessionSet(updated);
}

function bindTaskRoleRunInFlight(
  store: TaskStore,
  role: NonNullable<ReturnType<TaskStore["getRole"]>>,
  run: { id: string },
  now: Date
): void {
  const current = store.getRoleSessionSet(role.taskId, role.name)
    ?? createRoleSessionSet(
      { scope: "task", taskId: role.taskId, roleName: role.name },
      role.activeAgentId,
      now
    );
  const updated = bindTaskRoleRun(current, {
    agentId: role.activeAgentId,
    runId: run.id,
    receiptId: `agent-run:${run.id}`
  }, now);
  store.saveRoleSessionSet(updated);
}

function markTaskRoleRunDeliveredInFlight(
  store: TaskStore,
  role: NonNullable<ReturnType<TaskStore["getRole"]>>,
  run: { id: string },
  now: Date
): void {
  const current = store.getRoleSessionSet(role.taskId, role.name);
  if (current === null) {
    throw new Error(`Task Role session set is missing for delivered Run: ${run.id}.`);
  }
  const updated = markTaskRoleRunDelivered(current, {
    agentId: role.activeAgentId,
    runId: run.id,
    receiptId: `agent-run:${run.id}`
  }, now);
  store.saveRoleSessionSet(updated);
}

function clearTaskRoleRunInFlight(
  store: TaskStore,
  role: NonNullable<ReturnType<TaskStore["getRole"]>>,
  run: { id: string },
  now: Date
): void {
  const current = store.getRoleSessionSet(role.taskId, role.name);
  if (current === null) return;
  if (current.inFlight?.runId !== run.id) return;
  const updated = clearTaskRoleRun(current, {
    agentId: role.activeAgentId,
    runId: run.id,
    receiptId: `agent-run:${run.id}`
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

function requireRole(store: TaskStore, taskId: string, roleName: string) {
  const role = store.getRole(taskId, roleName);
  if (role === null) throw new Error(`Role not found: ${taskId}/${roleName}.`);
  return role;
}
