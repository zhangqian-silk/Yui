import { mergePendingWakeup } from "./pendingWakeup.js";
import { expireAgentRun, failAgentRun } from "../run/agentRun.js";
import { updateRoleStatus } from "../role/role.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { TmuxManager } from "../tmux/tmuxManager.js";
import { updateWorkItemStatus } from "../workItem/workItem.js";

export const DEFAULT_AGENT_RUN_TTL_MS = 4 * 60 * 60 * 1_000;

export function readAgentRunTtl(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_AGENT_RUN_TTL_MS);
  return Number.isFinite(parsed) && parsed >= 25 ? parsed : DEFAULT_AGENT_RUN_TTL_MS;
}

export function expireStaleAgentRuns(store: TaskStore, now: Date, ttlMs: number): string[] {
  const expired: string[] = [];

  for (const task of store.listTasks()) {
    for (const role of store.listRoles(task.id)) {
      const run = store.getActiveAgentRun(task.id, role.name);
      if (run === null || now.getTime() - Date.parse(run.updatedAt) < ttlMs) {
        continue;
      }

      const endedRun = expireAgentRun(run, now);
      store.saveAgentRun(endedRun);
      store.clearActiveAgentRun(task.id, role.name);
      store.saveRole(task.id, updateRoleStatus(role, "idle", now));
      const session = store.getAgentSession(task.id, role.name);
      if (session !== null) {
        store.saveAgentSession({ ...session, status: "ready", updatedAt: now.toISOString() });
      }
      failRunWorkItem(store, endedRun, endedRun.summary ?? "Agent run expired.", now);
      expired.push(run.id);

      if (!task.archived && role.name !== "leader") {
        store.savePendingWakeup(mergePendingWakeup(
          task.id,
          "role-run-expired",
          now,
          store.getPendingWakeup(task.id)
        ));
      }
    }
  }

  return expired;
}

export function failExitedAgentRuns(store: TaskStore, tmux: TmuxManager, now: Date): string[] {
  const failed: string[] = [];

  for (const task of store.listTasks()) {
    for (const role of store.listRoles(task.id)) {
      const run = store.getActiveAgentRun(task.id, role.name);
      if (run === null || tmux.detectRoleStatus(task.id, role.name, role.status) !== "exited") {
        continue;
      }

      const endedRun = failAgentRun(run, "The role's tmux window exited before the run yielded.", now);
      store.saveAgentRun(endedRun);
      store.clearActiveAgentRun(task.id, role.name);
      store.saveRole(task.id, updateRoleStatus(role, "exited", now));
      const session = store.getAgentSession(task.id, role.name);
      if (session !== null) {
        store.saveAgentSession({ ...session, status: "stopped", updatedAt: now.toISOString() });
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
