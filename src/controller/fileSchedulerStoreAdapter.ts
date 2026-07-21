import {
  createRoleSessionSet,
  recordRoleAgentSession,
  updateRoleAgentSessionStatus,
  type AgentSessionStatus,
  type GlobalRoleSessionSet,
  type RoleAgentSession,
  type TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import { activeRoleAgentBinding, updateRoleStatus } from "../role/role.js";
import { failAgentRun, markAgentRunDelivered } from "../run/agentRun.js";
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
import { pendingWakeupsMatch, type PendingWakeup } from "../scheduler/pendingWakeup.js";
import type { TaskStore } from "../storage/taskStore.js";
import { updateWorkItemStatus } from "../workItem/workItem.js";

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

  getRoleSession(taskId: string, roleName: string): SchedulerRoleSession | null {
    const session = this.store.getRoleSession(taskId, roleName);
    return session === null ? null : mapSession(session);
  }

  nextAgentRunId(taskId: string): string { return this.store.nextAgentRunId(taskId); }
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
      store.saveActiveAgentRun(input.run);
      store.saveRole(input.task.id, updateRoleStatus(role, "running", input.now));
      if (input.session !== null && input.session.nativeSessionId !== undefined) {
        saveTaskSession(store, role, {
          ...input.session,
          nativeSessionId: input.session.nativeSessionId
        }, "running", input.now);
      }
      store.clearLeaderFailure(input.task.id);
      store.clearOperatorNotification(input.task.id);
      store.clearPendingWakeup(input.task.id);
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
        }
        store.savePendingWakeup(restorePendingWakeup(
          input.claimed.wakeup,
          store.getPendingWakeup(input.task.id)
        ));
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

function restorePendingWakeup(
  claimed: PendingWakeup,
  current: PendingWakeup | null
): PendingWakeup {
  if (current === null) return claimed;
  return {
    schemaVersion: 1,
    taskId: claimed.taskId,
    reasons: [...new Set([...claimed.reasons, ...current.reasons])],
    requestCount: claimed.requestCount + current.requestCount,
    firstRequestedAt: claimed.firstRequestedAt,
    lastRequestedAt: current.lastRequestedAt
  };
}

function mapRole(role: ReturnType<TaskStore["getRole"]> extends infer _T ? NonNullable<ReturnType<TaskStore["getRole"]>> : never): SchedulerRole {
  const binding = activeRoleAgentBinding(role);
  return {
    taskId: role.taskId,
    name: role.name,
    activeAgentId: role.activeAgentId,
    adapterId: binding.adapterId,
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
