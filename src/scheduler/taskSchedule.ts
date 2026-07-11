export type TaskSchedule = {
  schemaVersion: 1;
  inactivityMinutes: number;
  cooldownMinutes: number;
  reviewAt?: string;
  recurring?: {
    everyMinutes: number;
    nextAt: string;
  };
  updatedAt: string;
};

export function createTaskSchedule(
  inactivityMinutes: number,
  cooldownMinutes: number,
  reviewAt: string | undefined,
  recurring: { everyMinutes: number; nextAt: string } | undefined,
  now: Date
): TaskSchedule {
  if (!Number.isFinite(inactivityMinutes) || inactivityMinutes < 0) {
    throw new Error("Inactivity minutes must be a non-negative number.");
  }
  if (!Number.isFinite(cooldownMinutes) || cooldownMinutes < 0) {
    throw new Error("Cooldown minutes must be a non-negative number.");
  }
  if (reviewAt !== undefined && Number.isNaN(Date.parse(reviewAt))) {
    throw new Error("Review time must be an ISO date-time.");
  }
  if (recurring !== undefined && (
    !Number.isFinite(recurring.everyMinutes) ||
    recurring.everyMinutes <= 0 ||
    Number.isNaN(Date.parse(recurring.nextAt))
  )) {
    throw new Error("Recurring schedule requires positive minutes and an ISO next time.");
  }

  return {
    schemaVersion: 1,
    inactivityMinutes,
    cooldownMinutes,
    ...(reviewAt === undefined ? {} : { reviewAt }),
    ...(recurring === undefined ? {} : { recurring }),
    updatedAt: now.toISOString()
  };
}
