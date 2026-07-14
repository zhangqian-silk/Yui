import { mergePendingWakeup } from "./pendingWakeup.js";
import { expireAgentRun, failAgentRun } from "../run/agentRun.js";
import { updateRoleStatus } from "../role/role.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { TmuxManager } from "../tmux/tmuxManager.js";
import { updateWorkItemStatus } from "../workItem/workItem.js";
import type { AgentRun } from "../run/agentRun.js";
import type { AgentSession } from "../executor/agentExecutor.js";
import type { PendingWakeup } from "./pendingWakeup.js";
import type { Role } from "../role/role.js";
import type { Task } from "../task/task.js";
import type { TaskSchedule } from "./taskSchedule.js";
import type { WorkItem } from "../workItem/workItem.js";

export const DEFAULT_AGENT_RUN_TTL_MS = 4 * 60 * 60 * 1_000;

export function readAgentRunTtl(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_AGENT_RUN_TTL_MS);
  return Number.isFinite(parsed) && parsed >= 25 ? parsed : DEFAULT_AGENT_RUN_TTL_MS;
}

export function expireStaleAgentRuns(store: TaskStore, now: Date, ttlMs: number): string[] {
  const expired: string[] = [];
  const pendingWakeups = new Map<string, PendingWakeup | null>();

  for (const plan of readActiveRunPlans(store)) {
    const { task, role, run } = plan;
    if (now.getTime() - Date.parse(run.updatedAt) < ttlMs) {
      continue;
    }

    const endedRun = expireAgentRun(run, now);
    store.saveAgentRun(endedRun);
    store.clearActiveAgentRun(task.id, role.name);
    store.saveRole(task.id, updateRoleStatus(role, "idle", now));
    if (plan.session !== null) {
      store.saveAgentSession({ ...plan.session, status: "ready", updatedAt: now.toISOString() });
    }
    failRunWorkItem(store, endedRun, plan.workItem, endedRun.summary ?? "Agent run expired.", now);
    expired.push(run.id);

    if (!task.archived && role.name !== "leader") {
      saveMergedWakeup(store, pendingWakeups, plan, "role-run-expired", now);
    }
  }

  return expired;
}

export function failExitedAgentRuns(store: TaskStore, tmux: TmuxManager, now: Date): string[] {
  const failed: string[] = [];
  const pendingWakeups = new Map<string, PendingWakeup | null>();

  for (const plan of readActiveRunPlans(store)) {
    const { task, role, run } = plan;
    if (tmux.detectRoleStatus(task.id, role.name, role.status) !== "exited") {
      continue;
    }

    const endedRun = failAgentRun(run, "The role's tmux window exited before the run yielded.", now);
    store.saveAgentRun(endedRun);
    store.clearActiveAgentRun(task.id, role.name);
    store.saveRole(task.id, updateRoleStatus(role, "exited", now));
    if (plan.session !== null) {
      store.saveAgentSession({ ...plan.session, status: "stopped", updatedAt: now.toISOString() });
    }
    failRunWorkItem(store, endedRun, plan.workItem, endedRun.summary ?? "Agent run failed.", now);
    failed.push(run.id);

    if (!task.archived) {
      saveMergedWakeup(
        store,
        pendingWakeups,
        plan,
        role.name === "leader" ? "leader-run-failed" : "role-run-failed",
        now
      );
    }
  }

  return failed;
}

function failRunWorkItem(
  store: TaskStore,
  run: { taskId: string; workItemId?: string },
  workItem: WorkItem | null,
  outcome: string,
  now: Date
): void {
  if (workItem !== null && workItem.status === "running") {
    store.saveWorkItem(run.taskId, updateWorkItemStatus(workItem, "failed", outcome, now));
  }
}

export function scanTaskWakeups(store: TaskStore, now: Date): string[] {
  const queued: string[] = [];

  for (const plan of readTaskWakeupPlans(store)) {
    const { task, schedule } = plan;
    if (task.archived || schedule === null || plan.hasActiveRole) {
      continue;
    }

    let pending = plan.pendingWakeup;
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

    const lastActivity = Math.max(...plan.activityTimes);
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

type ActiveRunPlan = Readonly<{
  task: Task;
  role: Role;
  run: AgentRun;
  session: AgentSession | null;
  workItem: WorkItem | null;
  pendingWakeup: PendingWakeup | null;
}>;

function readActiveRunPlans(store: TaskStore): ActiveRunPlan[] {
  return store.runReadSnapshot((snapshot) => {
    const plans: ActiveRunPlan[] = [];
    for (const task of snapshot.listTasks()) {
      const pendingWakeup = snapshot.getPendingWakeup(task.id);
      for (const role of snapshot.listRoles(task.id)) {
        const run = snapshot.getActiveAgentRun(task.id, role.name);
        if (run === null) {
          continue;
        }
        plans.push(Object.freeze({
          task,
          role,
          run,
          session: snapshot.getAgentSession(task.id, role.name),
          workItem: run.workItemId === undefined
            ? null
            : snapshot.getWorkItem(task.id, run.workItemId),
          pendingWakeup
        }));
      }
    }
    return plans;
  });
}

function saveMergedWakeup(
  store: TaskStore,
  pendingWakeups: Map<string, PendingWakeup | null>,
  plan: ActiveRunPlan,
  reason: string,
  now: Date
): void {
  const existing = pendingWakeups.has(plan.task.id)
    ? pendingWakeups.get(plan.task.id) ?? null
    : plan.pendingWakeup;
  const merged = mergePendingWakeup(plan.task.id, reason, now, existing);
  pendingWakeups.set(plan.task.id, merged);
  store.savePendingWakeup(merged);
}

type TaskWakeupPlan = Readonly<{
  task: Task;
  schedule: TaskSchedule | null;
  hasActiveRole: boolean;
  pendingWakeup: PendingWakeup | null;
  activityTimes: number[];
}>;

function readTaskWakeupPlans(store: TaskStore): TaskWakeupPlan[] {
  return store.runReadSnapshot((snapshot) => snapshot.listTasks().map((task) => {
    const roles = snapshot.listRoles(task.id);
    return Object.freeze({
      task,
      schedule: snapshot.getTaskSchedule(task.id),
      hasActiveRole: roles.some((role) => snapshot.getActiveAgentRun(task.id, role.name) !== null),
      pendingWakeup: snapshot.getPendingWakeup(task.id),
      activityTimes: [
        Date.parse(task.updatedAt),
        ...snapshot.listEvents(task.id).map((event) => Date.parse(event.createdAt)),
        ...snapshot.listComments(task.id).map((comment) => Date.parse(comment.createdAt))
      ].filter(Number.isFinite)
    });
  }));
}
