import { mergePendingWakeup } from "./pendingWakeup.js";
import type { TaskStore } from "../storage/taskStore.js";

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

    if (inactiveFor < schedule.inactivityMinutes * 60_000) {
      continue;
    }

    addReason("inactivity");
    queued.push(task.id);
  }

  return queued;
}
