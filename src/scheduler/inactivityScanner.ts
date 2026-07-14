import { randomUUID } from "node:crypto";
import { mergePendingWakeup } from "./pendingWakeup.js";
import { expireAgentRun, failAgentRun } from "../run/agentRun.js";
import { updateRoleStatus } from "../role/role.js";
import { updateRoleAgentSessionStatus } from "../executor/agentExecutor.js";
import { FileTaskStore, type TaskStore } from "../storage/taskStore.js";
import {
  executeDomainTransaction,
  hasActiveDomainTransactionAuthority
} from "../storage/domainTransaction.js";
import type { TmuxManager } from "../tmux/tmuxManager.js";
import { updateWorkItemStatus } from "../workItem/workItem.js";
import { createRoleExpiryNotification, roleExpiryNotificationId } from "./operatorNotification.js";
import {
  claimRoleRuntimeOperation,
  clearRoleRuntimeOperationClaim,
  createRoleRuntimeOperationLease,
  readRoleRuntimeOperationClaim,
  readRoleRuntimeStateSnapshot,
  roleRuntimeStateDigest,
  writeRoleRuntimeOperationClaim,
  type RoleRuntimeStateSnapshot,
  type RoleStopRuntimeOperationClaim
} from "../executor/roleRuntimeOperationClaim.js";

export const DEFAULT_AGENT_RUN_TTL_MS = 4 * 60 * 60 * 1_000;
export const DEFAULT_NATIVE_SESSION_REGISTRATION_TTL_MS = 60_000;

export function readAgentRunTtl(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_AGENT_RUN_TTL_MS);
  return Number.isFinite(parsed) && parsed >= 25 ? parsed : DEFAULT_AGENT_RUN_TTL_MS;
}

export function readNativeSessionRegistrationTtl(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_NATIVE_SESSION_REGISTRATION_TTL_MS);
  return Number.isFinite(parsed) && parsed >= 25 ? parsed : DEFAULT_NATIVE_SESSION_REGISTRATION_TTL_MS;
}

export function failUnregisteredNativeSessions(
  store: TaskStore,
  tmux: TmuxManager,
  now: Date,
  ttlMs: number
): string[] {
  const failed: string[] = [];
  for (const claim of prepareUnregisteredNativeSessionStops(store, now, ttlMs)) {
    const runId = store.getActiveAgentRun(claim.taskId, claim.roleName)?.id;
    if (processRoleRuntimeStopClaim(store, tmux, claim, now) === "failed") {
      if (runId !== undefined) failed.push(runId);
    }
  }
  return failed;
}

export function prepareUnregisteredNativeSessionStops(
  store: TaskStore,
  now: Date,
  ttlMs: number
): RoleStopRuntimeOperationClaim[] {
  const prepared: RoleStopRuntimeOperationClaim[] = [];
  const rootDir = roleRuntimeOperationRoot(store);
  for (const task of store.listTasks()) {
    for (const role of store.listRoles(task.id)) {
      const existingClaim = readRoleRuntimeOperationClaim(rootDir, task.id, role.name);
      if (existingClaim !== null) {
        if (
          existingClaim.kind === "stop" &&
          existingClaim.operation === "native-registration-timeout" &&
          isUnregisteredCodexState(readRoleRuntimeStateSnapshot(store, task.id, role.name))
        ) {
          prepared.push(existingClaim);
        }
        continue;
      }
      const run = store.getActiveAgentRun(task.id, role.name);
      if (run === null || run.mode !== "new" || now.getTime() - Date.parse(run.createdAt) < ttlMs) continue;
      const binding = role.agentBindings[role.activeAgentId];
      const session = store.getRoleSessionSet(task.id, role.name)?.sessions[role.activeAgentId];
      if (binding?.adapterId !== "codex" || session !== undefined) continue;

      const claim = createRoleRuntimeStopClaim(
        store,
        task.id,
        role.name,
        now,
        "native-registration-timeout"
      );
      persistRoleRuntimeOperationClaim(store, claim);
      prepared.push(claim);
    }
  }
  return prepared;
}

export type StaleAgentRunExpiration = RoleStopRuntimeOperationClaim;

export type StaleAgentRunExpirationResult = "expired" | "stop-failed" | "identity-drift";
export type RoleRuntimeStopClaimResult = StaleAgentRunExpirationResult | "failed";

export function prepareStaleAgentRunExpirations(
  store: TaskStore,
  now: Date,
  ttlMs: number
): StaleAgentRunExpiration[] {
  const prepared: StaleAgentRunExpiration[] = [];
  const rootDir = roleRuntimeOperationRoot(store);
  for (const task of store.listTasks()) {
    for (const role of store.listRoles(task.id)) {
      const existingClaim = readRoleRuntimeOperationClaim(rootDir, task.id, role.name);
      if (existingClaim !== null) {
        if (
          existingClaim.kind === "stop" &&
          existingClaim.operation === "ttl-stop"
        ) {
          prepared.push(existingClaim);
        }
        continue;
      }
      const run = store.getActiveAgentRun(task.id, role.name);
      if (run === null || now.getTime() - Date.parse(run.updatedAt) < ttlMs) continue;
      if (role.agentBindings[role.activeAgentId] === undefined) continue;
      const claim = createRoleRuntimeStopClaim(store, task.id, role.name, now);
      persistRoleRuntimeOperationClaim(store, claim);
      prepared.push(claim);
    }
  }
  return prepared;
}

export function staleAgentRunExpirationMatches(
  store: TaskStore,
  expiration: StaleAgentRunExpiration
): boolean {
  const persistedClaim = readRoleRuntimeOperationClaim(
    roleRuntimeOperationRoot(store),
    expiration.taskId,
    expiration.roleName
  );
  if (
    persistedClaim === null ||
    roleRuntimeStateDigest(persistedClaim) !== roleRuntimeStateDigest(expiration)
  ) {
    return false;
  }
  if (
    expiration.kind !== "stop" ||
    !["ttl-stop", "native-registration-timeout"].includes(expiration.operation) ||
    expiration.recoveryToken !== null ||
    store.getTask(expiration.taskId) === null
  ) return false;
  const snapshot = readRoleRuntimeStateSnapshot(store, expiration.taskId, expiration.roleName);
  return snapshot.role !== null &&
    snapshot.activeRun !== null &&
    snapshot.activeRun.status === "active" &&
    roleRuntimeStateDigest(snapshot) === expiration.expectedStateDigest;
}

export function recordStaleAgentRunExpirationFailure(
  store: TaskStore,
  expiration: StaleAgentRunExpiration,
  type: "role-expiry-stop-failed" | "role-expiry-identity-drift",
  now: Date
): void {
  if (store.getTask(expiration.taskId) === null) return;
  const snapshot = readRoleRuntimeStateSnapshot(store, expiration.taskId, expiration.roleName);
  const agentId = snapshot.role?.activeAgentId ?? "unknown-agent";
  const runId = snapshot.activeRun?.id ?? expiration.token;
  const notificationId = roleExpiryNotificationId(
    type,
    expiration.roleName,
    agentId,
    runId
  );
  store.saveOperatorNotification(createRoleExpiryNotification(
    expiration.taskId,
    expiration.roleName,
    agentId,
    runId,
    type,
    now,
    store.getOperatorNotification(expiration.taskId)
  ));
}

export function finalizeStaleAgentRunExpiration(
  store: TaskStore,
  expiration: StaleAgentRunExpiration,
  now: Date
): boolean {
  if (!staleAgentRunExpirationMatches(store, expiration)) return false;
  const snapshot = readRoleRuntimeStateSnapshot(store, expiration.taskId, expiration.roleName);
  const role = snapshot.role;
  const run = snapshot.activeRun;
  if (role === null || run === null) return false;
  clearRoleStopFailureNotifications(store, expiration);
  const endedRun = expireAgentRun(run, now);
  store.saveAgentRun(endedRun);
  store.clearActiveAgentRun(expiration.taskId, expiration.roleName);
  store.saveRole(expiration.taskId, updateRoleStatus(role, "idle", now));
  const sessionSet = snapshot.sessionSet;
  if (sessionSet !== null && sessionSet.sessions[role.activeAgentId] !== undefined) {
    store.saveRoleSessionSet(updateRoleAgentSessionStatus(sessionSet, role.activeAgentId, "ready", now));
  }
  failRunWorkItem(store, endedRun, endedRun.summary ?? "Agent run expired.", now);
  const task = store.getTask(expiration.taskId);
  if (task !== null && !task.archived && expiration.roleName !== "leader") {
    store.savePendingWakeup(mergePendingWakeup(
      expiration.taskId,
      "role-run-expired",
      now,
      store.getPendingWakeup(expiration.taskId)
    ));
  }
  clearRoleRuntimeOperationClaim(
    roleRuntimeOperationRoot(store),
    expiration.taskId,
    expiration.roleName,
    expiration.token
  );
  return true;
}

export function finalizeRoleRuntimeStopClaim(
  store: TaskStore,
  claim: RoleStopRuntimeOperationClaim,
  now: Date
): "expired" | "failed" | null {
  if (!staleAgentRunExpirationMatches(store, claim)) return null;
  const snapshot = readRoleRuntimeStateSnapshot(store, claim.taskId, claim.roleName);
  if (claim.operation === "ttl-stop") {
    return finalizeStaleAgentRunExpiration(store, claim, now) ? "expired" : null;
  }
  if (claim.operation !== "native-registration-timeout" || !isUnregisteredCodexState(snapshot)) {
    return null;
  }
  const task = store.getTask(claim.taskId);
  const role = snapshot.role;
  const run = snapshot.activeRun;
  if (task === null || role === null || run === null) return null;

  clearRoleStopFailureNotifications(store, claim);
  const endedRun = failAgentRun(
    run,
    "Codex did not register its native session identity before the deadline.",
    now
  );
  store.saveAgentRun(endedRun);
  store.clearActiveAgentRun(claim.taskId, claim.roleName);
  store.saveRole(claim.taskId, updateRoleStatus(role, "failed", now));
  failRunWorkItem(store, endedRun, endedRun.summary ?? "Native session registration failed.", now);
  if (!task.archived) {
    store.savePendingWakeup(mergePendingWakeup(
      task.id,
      role.name === "leader" ? "leader-run-failed" : "role-run-failed",
      now,
      store.getPendingWakeup(task.id)
    ));
  }
  clearRoleRuntimeOperationClaim(
    roleRuntimeOperationRoot(store),
    claim.taskId,
    claim.roleName,
    claim.token
  );
  return "failed";
}

export function processRoleRuntimeStopClaim(
  store: TaskStore,
  tmux: Pick<TmuxManager, "killRoleAndConfirmStopped">,
  claim: RoleStopRuntimeOperationClaim,
  now: Date
): RoleRuntimeStopClaimResult {
  if (!staleAgentRunExpirationMatches(store, claim)) {
    recordStaleAgentRunExpirationFailure(store, claim, "role-expiry-identity-drift", now);
    return "identity-drift";
  }
  try {
    tmux.killRoleAndConfirmStopped(claim.taskId, claim.roleName);
  } catch {
    recordStaleAgentRunExpirationFailure(store, claim, "role-expiry-stop-failed", now);
    return "stop-failed";
  }
  const result = finalizeOwnedRoleRuntimeStopClaim(store, claim, now);
  if (result === null) {
    recordStaleAgentRunExpirationFailure(store, claim, "role-expiry-identity-drift", now);
    return "identity-drift";
  }
  return result;
}

export function expireStaleAgentRun(
  store: TaskStore,
  tmux: Pick<TmuxManager, "killRoleAndConfirmStopped">,
  expiration: StaleAgentRunExpiration,
  now: Date
): StaleAgentRunExpirationResult {
  const result = processRoleRuntimeStopClaim(store, tmux, expiration, now);
  return result === "failed" ? "identity-drift" : result;
}

export function expireStaleAgentRuns(
  store: TaskStore,
  tmux: Pick<TmuxManager, "killRoleAndConfirmStopped">,
  now: Date,
  ttlMs: number
): string[] {
  const expired: string[] = [];
  for (const expiration of prepareStaleAgentRunExpirations(store, now, ttlMs)) {
    const runId = store.getActiveAgentRun(expiration.taskId, expiration.roleName)?.id;
    if (expireStaleAgentRun(store, tmux, expiration, now) === "expired") {
      if (runId !== undefined) expired.push(runId);
    }
  }
  return expired;
}

export function failExitedAgentRuns(store: TaskStore, tmux: TmuxManager, now: Date): string[] {
  const failed: string[] = [];

  for (const task of store.listTasks()) {
    for (const role of store.listRoles(task.id)) {
      if (readRoleRuntimeOperationClaim(roleRuntimeOperationRoot(store), task.id, role.name) !== null) continue;
      const run = store.getActiveAgentRun(task.id, role.name);
      if (run === null || tmux.detectRoleStatus(task.id, role.name, role.status) !== "exited") {
        continue;
      }

      const endedRun = failAgentRun(run, "The role's tmux window exited before the run yielded.", now);
      store.saveAgentRun(endedRun);
      store.clearActiveAgentRun(task.id, role.name);
      store.saveRole(task.id, updateRoleStatus(role, "exited", now));
      const sessionSet = store.getRoleSessionSet(task.id, role.name);
      if (sessionSet !== null && sessionSet.sessions[role.activeAgentId] !== undefined) {
        store.saveRoleSessionSet(updateRoleAgentSessionStatus(sessionSet, role.activeAgentId, "stopped", now));
      }
      failRunWorkItem(store, endedRun, endedRun.summary ?? "Agent run failed.", now);
      failed.push(run.id);

      if (!task.archived) {
        store.savePendingWakeup(mergePendingWakeup(
          task.id,
          role.name === "leader" ? "leader-run-failed" : "role-run-failed",
          now,
          store.getPendingWakeup(task.id)
        ));
      }
    }
  }

  return failed;
}

function failRunWorkItem(
  store: TaskStore,
  run: { taskId: string; workItemId?: string },
  outcome: string,
  now: Date
): void {
  if (run.workItemId === undefined) {
    return;
  }
  const workItem = store.getWorkItem(run.taskId, run.workItemId);
  if (workItem !== null && workItem.status === "running") {
    store.saveWorkItem(run.taskId, updateWorkItemStatus(workItem, "failed", outcome, now));
  }
}

function clearRoleStopFailureNotifications(store: TaskStore, claim: RoleStopRuntimeOperationClaim): void {
  const snapshot = readRoleRuntimeStateSnapshot(store, claim.taskId, claim.roleName);
  const agentId = snapshot.role?.activeAgentId ?? "unknown-agent";
  const runId = snapshot.activeRun?.id ?? claim.token;
  for (const type of ["role-expiry-stop-failed", "role-expiry-identity-drift"] as const) {
    const notificationId = roleExpiryNotificationId(type, claim.roleName, agentId, runId);
    const notification = store.getOperatorNotification(claim.taskId);
    if (notification?.id === notificationId) {
      store.clearOperatorNotification(claim.taskId);
    }
  }
}

function finalizeOwnedRoleRuntimeStopClaim(
  store: TaskStore,
  claim: RoleStopRuntimeOperationClaim,
  now: Date
): "expired" | "failed" | null {
  if (hasActiveDomainTransactionAuthority(store.rootDirectory())) {
    if (!(store instanceof FileTaskStore)) {
      throw new Error("Role runtime finalization requires a FileTaskStore workspace.");
    }
    return finalizeRoleRuntimeStopClaim(
      FileTaskStore.forDomainTransactionWorkspace(
        store.rootDirectory(),
        claim.token,
        claim.recoveryToken ?? undefined
      ),
      claim,
      now
    );
  }
  return executeDomainTransaction(store.rootDirectory(), `role-ttl-stop-finalize-${randomUUID()}`, (workingRoot) =>
    finalizeRoleRuntimeStopClaim(
      FileTaskStore.forDomainTransactionWorkspace(
        workingRoot,
        claim.token,
        claim.recoveryToken ?? undefined
      ),
      claim,
      now
    )
  );
}

function createRoleRuntimeStopClaim(
  store: TaskStore,
  taskId: string,
  roleName: string,
  now: Date,
  operation: "ttl-stop" | "native-registration-timeout" = "ttl-stop"
): RoleStopRuntimeOperationClaim {
  const snapshot = readRoleRuntimeStateSnapshot(store, taskId, roleName);
  if (snapshot.role === null) {
    throw new Error(`Cannot reserve a missing Role for TTL stop: ${taskId}/${roleName}.`);
  }
  return {
    schemaVersion: 1,
    scope: "task-role",
    kind: "stop",
    token: randomUUID(),
    taskId,
    roleName,
    operation,
    ownerPid: process.pid,
    preparedSession: null,
    selectedWorkItem: null,
    pendingRun: null,
    expectedStateDigest: roleRuntimeStateDigest(snapshot),
    recoveryToken: null,
    ...createRoleRuntimeOperationLease(now),
    phase: "prepared",
    targetLaunchToken: null,
    preparedRole: snapshot.role,
    restartLaunch: null
  };
}

function persistRoleRuntimeOperationClaim(
  store: TaskStore,
  claim: RoleStopRuntimeOperationClaim
): void {
  const rootDir = roleRuntimeOperationRoot(store);
  if (hasActiveDomainTransactionAuthority(store.rootDirectory())) {
    writeRoleRuntimeOperationClaim(rootDir, claim, roleRuntimeStateDigest(
      readRoleRuntimeStateSnapshot(store, claim.taskId, claim.roleName)
    ));
    return;
  }
  claimRoleRuntimeOperation(
    rootDir,
    `role-ttl-stop-${randomUUID()}`,
    claim,
    (workingRoot) => roleRuntimeStateDigest(readRoleRuntimeStateSnapshot(
      new FileTaskStore(workingRoot),
      claim.taskId,
      claim.roleName
    ))
  );
}

function roleRuntimeOperationRoot(store: TaskStore): string {
  return store.rootDirectory();
}

function isUnregisteredCodexState(snapshot: RoleRuntimeStateSnapshot): boolean {
  if (snapshot.role === null || snapshot.activeRun === null || snapshot.activeRun.mode !== "new") return false;
  const role = snapshot.role;
  return role.agentBindings[role.activeAgentId]?.adapterId === "codex" &&
    snapshot.sessionSet?.sessions[role.activeAgentId] === undefined;
}

export function scanTaskWakeups(store: TaskStore, now: Date): string[] {
  const queued: string[] = [];

  for (const task of store.listTasks()) {
    const schedule = store.getTaskSchedule(task.id);
    if (task.archived || schedule === null) {
      continue;
    }

    if (store.listRoles(task.id).some((role) => store.getActiveAgentRun(task.id, role.name) !== null)) {
      continue;
    }

    let pending = store.getPendingWakeup(task.id);
    let currentSchedule = schedule;
    let taskQueued = false;
    const addReason = (reason: string): void => {
      if (pending?.reasons.includes(reason) === true) {
        return;
      }
      pending = mergePendingWakeup(task.id, reason, now, pending);
      store.savePendingWakeup(pending);
      taskQueued = true;
    };

    if (schedule.reviewAt !== undefined && Date.parse(schedule.reviewAt) <= now.getTime()) {
      addReason("review-time");
      const { reviewAt: _reviewAt, ...withoutReview } = currentSchedule;
      currentSchedule = { ...withoutReview, updatedAt: now.toISOString() };
    }

    if (schedule.recurring !== undefined && Date.parse(schedule.recurring.nextAt) <= now.getTime()) {
      addReason("schedule");
      const interval = schedule.recurring.everyMinutes * 60_000;
      const previousNext = Date.parse(schedule.recurring.nextAt);
      const elapsedIntervals = Math.floor((now.getTime() - previousNext) / interval) + 1;
      currentSchedule = {
        ...currentSchedule,
        recurring: {
          ...schedule.recurring,
          nextAt: new Date(previousNext + elapsedIntervals * interval).toISOString()
        },
        updatedAt: now.toISOString()
      };
    }

    if (currentSchedule !== schedule) {
      store.saveTaskSchedule(task.id, currentSchedule);
    }

    if (schedule.reviewAt !== undefined && Date.parse(schedule.reviewAt) > now.getTime()) {
      if (taskQueued) {
        queued.push(task.id);
      }
      continue;
    }

    if (pending !== null) {
      if (taskQueued) {
        queued.push(task.id);
      }
      continue;
    }

    const activityTimes = [
      Date.parse(task.updatedAt),
      ...store.listEvents(task.id).map((event) => Date.parse(event.createdAt)),
      ...store.listComments(task.id).map((comment) => Date.parse(comment.createdAt))
    ].filter(Number.isFinite);
    const lastActivity = Math.max(...activityTimes);
    const inactiveFor = now.getTime() - lastActivity;

    if (
      schedule.lastLeaderWakeupAt !== undefined &&
      now.getTime() - Date.parse(schedule.lastLeaderWakeupAt) < schedule.cooldownMinutes * 60_000
    ) {
      continue;
    }

    if (inactiveFor < schedule.inactivityMinutes * 60_000) {
      continue;
    }

    addReason("inactivity");
    queued.push(task.id);
  }

  return queued;
}
