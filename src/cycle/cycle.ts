export const CYCLE_CAUSES = [
  "task-created",
  "user-comment",
  "schedule",
  "review-time",
  "operator-input",
  "role-result",
  "inactivity",
  "explicit-wake"
] as const;

export type CycleCause = typeof CYCLE_CAUSES[number];

export type Cycle = {
  schemaVersion: 1;
  id: string;
  taskId: string;
  cause: CycleCause;
  summary: string;
  topics: string[];
  status: "active" | "ended";
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
};

export function createCycle(
  id: string,
  taskId: string,
  cause: CycleCause,
  summary: string,
  now: Date,
  topics: string[] = []
): Cycle {
  const trimmedSummary = summary.trim();

  if (trimmedSummary.length === 0) {
    throw new Error("Cycle summary is required.");
  }

  const timestamp = now.toISOString();

  return {
    schemaVersion: 1,
    id,
    taskId,
    cause,
    summary: trimmedSummary,
    topics: [...new Set(topics)],
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function endCycle(cycle: Cycle, summary: string, now: Date): Cycle {
  const trimmedSummary = summary.trim();
  if (trimmedSummary.length === 0) {
    throw new Error("Cycle ending summary is required.");
  }
  const timestamp = now.toISOString();
  return {
    ...cycle,
    summary: trimmedSummary,
    status: "ended",
    updatedAt: timestamp,
    endedAt: timestamp
  };
}
